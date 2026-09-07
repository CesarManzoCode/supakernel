/**
 * D1 migration engine on real workerd (contract §17.1, §30 L3): lease + per-step journal +
 * observable postcondition + resume. Reuses the wrangler dev instance started by
 * d1.contract.test.ts's sibling harness — here we spawn our own so the file is standalone.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DatabaseCapabilities,
  DbResult,
  DbRow,
  ObservedSchema,
  SqlStatement,
  SqlValue,
  Transaction,
  TransactionOptions,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import {
  applyMigration,
  hashSchema,
  JOURNAL_DDL,
  normalizeSchema,
  parsePgSchema,
  planMigration,
} from '@supakernel/schema'
import { afterAll, beforeAll, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 8817
const BASE = `http://127.0.0.1:${PORT}`
const wranglerBin = join(
  here,
  '../../../../node_modules/.pnpm/wrangler@4.129.0/node_modules/wrangler/bin/wrangler.js',
)
const fixtures = join(here, '../../../../fixtures/schema')
let proc: ChildProcess | undefined

type Wire =
  | { $: 'bytes'; b: number[] }
  | { $: 'bigint'; v: string }
  | null
  | boolean
  | number
  | string
const encode = (v: SqlValue): Wire =>
  v instanceof Uint8Array
    ? { $: 'bytes', b: [...v] }
    : typeof v === 'bigint'
      ? { $: 'bigint', v: v.toString() }
      : v
const decode = (v: Wire): SqlValue =>
  v !== null && typeof v === 'object'
    ? v.$ === 'bytes'
      ? new Uint8Array(v.b)
      : BigInt(v.v)
    : (v as SqlValue)

async function rpc(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || json.error) {
    const err = new Error(String(json.message ?? `HTTP ${res.status}`))
    if (json.kernelError) (err as Error & { kernelError: unknown }).kernelError = json.kernelError
    throw err
  }
  return json
}

class RemoteD1Adapter implements DatabaseAdapter {
  readonly id = 'sqlite-d1'
  readonly runtime = 'workers' as const
  readonly capabilities: DatabaseCapabilities = {
    family: 'sqlite',
    transactions: 'atomic-batch',
    ddlAtomicity: 'step-journal',
    nativeRls: false,
    returning: true,
    json: 'json-text',
    changeCapture: 'managed-triggers',
    isolation: ['serializable'],
  }
  async execute(s: SqlStatement, _t?: Transaction): Promise<DbResult> {
    const r = (await rpc('/execute', { text: s.text, parameters: s.parameters.map(encode) })) as {
      rows: Record<string, Wire>[]
      rowCount: number
    }
    return {
      rows: r.rows.map((row) => {
        const o: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(row)) o[k] = decode(v)
        return o as DbRow
      }),
      rowCount: r.rowCount,
    }
  }
  transaction<T>(_o: TransactionOptions, _f: (t: Transaction) => Promise<T>): Promise<T> {
    return Promise.reject(new Error('SK_CAPABILITY: D1 has no interactive transaction'))
  }
  async atomicBatch(stmts: readonly SqlStatement[]): Promise<readonly DbResult[]> {
    const r = (await rpc('/batch', {
      statements: stmts.map((s) => ({ text: s.text, parameters: s.parameters.map(encode) })),
    })) as { results: { rowCount: number }[] }
    return r.results.map((x) => ({ rows: [], rowCount: x.rowCount }))
  }
  introspect(): Promise<ObservedSchema> {
    return rpc('/introspect', {}) as Promise<ObservedSchema>
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  async [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

async function waitReady(ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'SELECT 1 AS one', parameters: [] }),
      })
      if (r.ok) return
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev not ready')
}

async function startWrangler(): Promise<void> {
  proc = spawn(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      join(here, '.wrangler-mig'),
    ],
    { cwd: here, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
  )
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  await waitReady(60_000)
}
async function stopWrangler(): Promise<void> {
  proc?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  proc?.kill('SIGKILL')
}

beforeAll(async () => {
  rmSync(join(here, '.wrangler-mig'), { recursive: true, force: true })
  await startWrangler()
}, 90_000)

afterAll(async () => {
  await stopWrangler()
  rmSync(join(here, '.wrangler-mig'), { recursive: true, force: true })
})

it('applies a portable schema on real D1 via the lease + step journal', async () => {
  await rpc('/reset', {})
  const adapter = new RemoteD1Adapter()
  const { schema } = await parsePgSchema(
    readFileSync(join(fixtures, 'portable/002-project-task.sql'), 'utf8'),
  )
  const plan = planMigration({ version: 1, tables: [], sequences: [], policies: [] }, schema, {
    family: 'sqlite',
  })
  const applied = await applyMigration(adapter, plan, {
    now: new Date().toISOString(),
    holder: 'h1',
  })
  expect(applied.status).toBe('applied')
  expect(hashSchema(normalizeSchema(await adapter.introspect()))).toBe(hashSchema(schema))
})

it('resumes a partially-journaled migration and finishes it exactly once', async () => {
  await rpc('/reset', {})
  const adapter = new RemoteD1Adapter()
  const { schema } = await parsePgSchema(
    readFileSync(join(fixtures, 'portable/002-project-task.sql'), 'utf8'),
  )
  const plan = planMigration({ version: 1, tables: [], sequences: [], policies: [] }, schema, {
    family: 'sqlite',
  })
  expect(plan.steps.length).toBeGreaterThan(2)

  // Simulate a crash after the first step's atomic batch committed: apply exactly that step
  // and its journal row by hand, then let the engine resume the rest.
  const firstStep = plan.steps[0]
  if (!firstStep) throw new Error('empty plan')
  for (const ddl of JOURNAL_DDL) await adapter.execute({ text: ddl, parameters: [] })
  await adapter.atomicBatch([
    ...firstStep.forward.filter((s) => !s.text.trim().startsWith('--')),
    {
      text: `INSERT INTO _sk_migration_journal (plan_id, step_id, phase, state, checksum, updated_at)
             VALUES (?, ?, ?, 'applied', ?, ?)`,
      parameters: [
        plan.id,
        firstStep.id,
        firstStep.phase,
        firstStep.checksum,
        new Date().toISOString(),
      ],
    },
  ])

  // A full wrangler restart in between, so nothing but the journal survives.
  await stopWrangler()
  await startWrangler()

  const resumed = await applyMigration(adapter, plan, {
    now: new Date().toISOString(),
    holder: 'resumer',
  })
  expect(resumed.status).toBe('resumed')
  expect(resumed.stepsApplied).toBe(plan.steps.length - 1)
  expect(hashSchema(normalizeSchema(await adapter.introspect()))).toBe(hashSchema(schema))

  // running it once more is a clean no-op
  const again = await applyMigration(adapter, plan, {
    now: new Date().toISOString(),
    holder: 'again',
  })
  expect(again.status).toBe('noop')
})
