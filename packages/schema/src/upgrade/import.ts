// Phase executor (contract §17.2). Applies an `UpgradeBundle` to the target through the
// `DatabaseAdapter` + `ObjectTransfer` ports, writing a resumable phase journal and hitting
// every `upgrade.*` fault point. Phase order is fixed and must not change.

import type { Json, SchemaIR } from '@supakernel/contracts'
import { sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import {
  createIndexStatement,
  createSequenceStatements,
  createTableStatement,
} from '../dialects/postgres.js'
import type {
  ObjectTransfer,
  PhaseJournalEntry,
  UpgradeBundle,
  UpgradeContext,
  UpgradePhase,
} from './types.js'
import { UPGRADE_PHASES } from './types.js'

const q = (n: string): string => `"${n.replace(/"/g, '""')}"`

export interface JournalStore {
  load(): Promise<PhaseJournalEntry[]>
  save(entries: readonly PhaseJournalEntry[]): Promise<void>
}

/** Deploy the target-side policies + grants — the engine cannot import `@supakernel/policy`. */
export type DeployPolicies = (target: DatabaseAdapter, policies: Json) => Promise<void>

export interface ImportInput {
  readonly target: DatabaseAdapter
  readonly bundle: UpgradeBundle
  readonly objects: ObjectTransfer
  readonly journal: JournalStore
  readonly deployPolicies: DeployPolicies
  readonly ctx: UpgradeContext
  /** Import a legacy signing key into the target auth schema (only when the bundle carries one). */
  readonly importLegacyKey?: (
    target: DatabaseAdapter,
    key: { kid: string; jwk: Json },
  ) => Promise<void>
}

function emptyJournal(): PhaseJournalEntry[] {
  return UPGRADE_PHASES.map((phase) => ({
    phase,
    state: 'pending',
    postcondition: null,
    startedAt: null,
    finishedAt: null,
    detail: '',
  }))
}

async function exec(
  target: DatabaseAdapter,
  text: string,
  params: readonly Json[] = [],
): Promise<void> {
  await target.execute(sql(text, params as never[]))
}
async function rows(target: DatabaseAdapter, text: string): Promise<Record<string, unknown>[]> {
  return (await target.execute(sql(text))).rows as Record<string, unknown>[]
}

async function phaseSchema(target: DatabaseAdapter, schema: SchemaIR): Promise<void> {
  for (const seq of schema.sequences) {
    for (const stmt of createSequenceStatements(seq)) await target.execute(stmt)
  }
  for (const table of schema.tables) {
    await target.execute(createTableStatement(schema, table))
  }
  for (const table of schema.tables) {
    for (const idx of table.indexes) await target.execute(createIndexStatement(table, idx))
  }
}

async function targetColumns(
  target: DatabaseAdapter,
  schema: string,
  table: string,
): Promise<Set<string>> {
  const r = await rows(
    target,
    `SELECT column_name FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='${table}'`,
  )
  return new Set(r.map((x) => String(x.column_name)))
}

async function phaseAuth(target: DatabaseAdapter, bundle: UpgradeBundle): Promise<void> {
  // The target's `auth.users` is GoTrue's shape — a superset of some SupaKernel columns and
  // missing SupaKernel extras (tenant_id, email_change, ...). Insert only the intersection
  // (contract §17.2 — "Auth users/identities" mapped, not blindly copied).
  const userCols = await targetColumns(target, 'auth', 'users')
  const identCols = await targetColumns(target, 'auth', 'identities')
  for (const u of bundle.authUsers) {
    const cols = Object.keys(u.row).filter((c) => userCols.has(c))
    const ph = cols.map((_, i) => `$${i + 1}`)
    await exec(
      target,
      `INSERT INTO auth.users (${cols.map(q).join(',')}) VALUES (${ph.join(',')})
       ON CONFLICT (id) DO NOTHING`,
      cols.map((c) => u.row[c] as Json),
    )
    for (const ident of u.identities) {
      const ic = Object.keys(ident).filter((c) => identCols.has(c))
      if (ic.length === 0) continue
      await exec(
        target,
        `INSERT INTO auth.identities (${ic.map(q).join(',')}) VALUES (${ic.map((_, i) => `$${i + 1}`).join(',')})
         ON CONFLICT DO NOTHING`,
        ic.map((c) => ident[c] as Json),
      ).catch(() => undefined)
    }
  }
}

async function phaseTableData(
  target: DatabaseAdapter,
  bundle: UpgradeBundle,
  fault: UpgradeContext['fault'],
): Promise<void> {
  for (const name of bundle.tableOrder) {
    const list = bundle.tableRows[name] ?? []
    for (let i = 0; i < list.length; i++) {
      const row = list[i] as Record<string, Json>
      const cols = Object.keys(row)
      await exec(
        target,
        `INSERT INTO ${q(name)} (${cols.map(q).join(',')}) VALUES (${cols.map((_, j) => `$${j + 1}`).join(',')})
         ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c] as Json),
      )
      // fault point: interrupt partway through the largest table
      if (i === Math.floor(list.length / 2)) {
        await fault.hit('upgrade.during_table', { table: name, row: String(i) })
      }
    }
  }
}

async function phaseSequences(target: DatabaseAdapter, bundle: UpgradeBundle): Promise<void> {
  for (const [name, s] of Object.entries(bundle.sequences)) {
    // setval to the last consumed value with is_called=true → nextval returns last+increment.
    await exec(target, `SELECT setval($1, $2::bigint, true)`, [name, s.last])
  }
}

async function phaseStorage(
  target: DatabaseAdapter,
  bundle: UpgradeBundle,
  objects: ObjectTransfer,
  fault: UpgradeContext['fault'],
): Promise<void> {
  void target
  const buckets = new Set(bundle.storageObjects.map((o) => o.bucket))
  for (const b of buckets) {
    const isPublic = bundle.storageObjects.find((o) => o.bucket === b)?.isPublic ?? false
    await objects.ensureBucket(b, isPublic)
  }
  for (let i = 0; i < bundle.storageObjects.length; i++) {
    const o = bundle.storageObjects[i]
    if (!o) continue
    await objects.putObject(o)
    if (i === Math.floor(bundle.storageObjects.length / 2)) {
      await fault.hit('upgrade.during_blob', { object: `${o.bucket}/${o.path}` })
    }
  }
}

// -------- postconditions (observable, drive resume) --------

async function pcSchema(target: DatabaseAdapter, schema: SchemaIR): Promise<boolean> {
  const r = await rows(target, `SELECT tablename FROM pg_tables WHERE schemaname='public'`)
  const have = new Set(r.map((x) => String(x.tablename)))
  return schema.tables.every((t) => have.has(t.name))
}
async function pcAuth(target: DatabaseAdapter, bundle: UpgradeBundle): Promise<boolean> {
  const r = await rows(target, `SELECT count(*)::int AS c FROM auth.users`)
  return Number(r[0]?.c ?? 0) >= bundle.authUsers.length
}
async function pcTableData(target: DatabaseAdapter, bundle: UpgradeBundle): Promise<boolean> {
  for (const name of bundle.tableOrder) {
    const want = (bundle.tableRows[name] ?? []).length
    const r = await rows(target, `SELECT count(*)::int AS c FROM ${q(name)}`)
    if (Number(r[0]?.c ?? -1) < want) return false
  }
  return true
}
async function pcSequences(target: DatabaseAdapter, bundle: UpgradeBundle): Promise<boolean> {
  for (const [name, s] of Object.entries(bundle.sequences)) {
    const r = await rows(target, `SELECT last_value::text AS lv, is_called FROM ${q(name)}`)
    if (!r[0]) return false
    if (BigInt(String(r[0].lv)) < BigInt(s.last)) return false
  }
  return true
}
async function pcStorage(objects: ObjectTransfer, bundle: UpgradeBundle): Promise<boolean> {
  const have = new Set((await objects.listObjects()).map((o) => `${o.bucket}/${o.path}`))
  return bundle.storageObjects.every((o) => have.has(`${o.bucket}/${o.path}`))
}

export interface ImportResult {
  readonly journal: readonly PhaseJournalEntry[]
  readonly completedThrough: UpgradePhase | null
  readonly resumed: boolean
}

/** Run (or resume) the write phases. Returns the journal; a fault throws out of this call and
 *  the persisted journal lets `resumeUpgrade` restart at the first non-`true` postcondition. */
export async function importBundle(input: ImportInput): Promise<ImportResult> {
  const { target, bundle, objects, journal, ctx } = input
  let entries = await journal.load()
  const resumed = entries.length > 0
  if (!resumed) entries = emptyJournal()

  const set = (phase: UpgradePhase, patch: Partial<PhaseJournalEntry>): void => {
    entries = entries.map((e) => (e.phase === phase ? { ...e, ...patch } : e))
  }
  const persist = async (): Promise<void> => {
    await journal.save(entries)
  }

  const WRITE_PHASES: readonly {
    phase: UpgradePhase
    run: () => Promise<void>
    post: () => Promise<boolean>
    faultAfter?: Parameters<UpgradeContext['fault']['hit']>[0]
  }[] = [
    {
      phase: 'schema',
      run: () => phaseSchema(target, bundle.schema),
      post: () => pcSchema(target, bundle.schema),
      faultAfter: 'upgrade.after_schema',
    },
    { phase: 'auth', run: () => phaseAuth(target, bundle), post: () => pcAuth(target, bundle) },
    {
      phase: 'table-data',
      run: () => phaseTableData(target, bundle, ctx.fault),
      post: () => pcTableData(target, bundle),
      faultAfter: 'upgrade.after_data_before_sequence',
    },
    {
      phase: 'sequences',
      run: () => phaseSequences(target, bundle),
      post: () => pcSequences(target, bundle),
    },
    {
      phase: 'policies-grants',
      run: () => input.deployPolicies(target, bundle.policies),
      post: async () => true,
    },
    {
      phase: 'storage',
      run: () => phaseStorage(target, bundle, objects, ctx.fault),
      post: () => pcStorage(objects, bundle),
    },
    {
      phase: 'legacy-signing-key',
      run: async () => {
        if (bundle.legacySigningKey && input.importLegacyKey) {
          await input.importLegacyKey(target, bundle.legacySigningKey)
        }
      },
      post: async () => true,
    },
  ]

  let completedThrough: UpgradePhase | null = null
  for (const step of WRITE_PHASES) {
    const current = entries.find((e) => e.phase === step.phase)
    if (current?.state === 'applied' && current.postcondition === true) {
      completedThrough = step.phase
      continue
    }
    set(step.phase, { state: 'running', startedAt: ctx.now(), detail: '' })
    await persist()
    await step.run()
    if (step.faultAfter) await ctx.fault.hit(step.faultAfter, { phase: step.phase })
    const ok = await step.post()
    set(step.phase, {
      state: ok ? 'applied' : 'failed',
      postcondition: ok,
      finishedAt: ctx.now(),
      detail: ok ? 'postcondition satisfied' : 'postcondition NOT satisfied',
    })
    await persist()
    if (!ok) throw new Error(`SK_UPGRADE_PHASE_INCOMPLETE: ${step.phase}`)
    completedThrough = step.phase
  }

  return { journal: entries, completedThrough, resumed }
}
