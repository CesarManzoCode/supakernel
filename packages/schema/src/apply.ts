import {
  kernelError,
  type ObservedSchema,
  type ProjectSchema,
  type SqlStatement,
  sql,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import {
  acquireLease,
  appliedStepIds,
  currentSchemaHash,
  ensureJournal,
  journalStepStatement,
  recordSchemaHashStatement,
  releaseLease,
} from './journal.js'
import type { MigrationPlan, MigrationStep } from './plan.js'
import { destructiveRefusalError } from './plan.js'

export interface ApplyResult {
  readonly status: 'applied' | 'noop' | 'resumed'
  readonly planId: string
  readonly stepsApplied: number
  readonly schemaHash: string
}

export interface ApplyOptions {
  readonly now: string
  readonly holder?: string
}

/**
 * Apply a `MigrationPlan` through a `DatabaseAdapter` port (contract §17.1, §30 L3).
 *
 *  - transactional adapters (`transactions === 'callback'`): the whole plan + the journal +
 *    the schema-hash record run in ONE transaction. A crash rolls everything back.
 *  - D1 (`transactions === 'atomic-batch'`): a lease is taken, then each step runs as its own
 *    atomic batch with a journal row and an observable postcondition; a resumed run skips
 *    steps already marked `applied` and re-checks each postcondition.
 */
export async function applyMigration(
  adapter: DatabaseAdapter,
  plan: MigrationPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  if (plan.risk === 'destructive-refused') {
    throw new Error(destructiveRefusalError(plan).message)
  }

  await ensureJournal(adapter)
  const before = await currentSchemaHash(adapter)
  if (before === plan.toHash || plan.steps.length === 0) {
    return { status: 'noop', planId: plan.id, stepsApplied: 0, schemaHash: plan.toHash }
  }
  if (before !== null && before !== plan.fromHash) {
    throw new Error(
      kernelError({
        category: 'integrity',
        code: 'SK_MIGRATION_DRIFT',
        message: `SK_MIGRATION_DRIFT: database schema hash ${before} does not match the plan's fromHash ${plan.fromHash}`,
        httpStatus: 409,
      }).message,
    )
  }

  const flatten = (step: MigrationStep): SqlStatement[] =>
    step.forward.filter((s) => !s.text.trim().startsWith('--'))

  // The migration DDL is already dialect-compiled by `plan`; only the journal / schema-lock
  // statements below carry `?` placeholders, which PostgreSQL needs rewritten to `$n`.
  const meta =
    plan.family === 'postgres'
      ? (s: SqlStatement): SqlStatement => pgPlaceholders(s)
      : (s: SqlStatement): SqlStatement => s

  if (adapter.capabilities.transactions === 'callback') {
    await adapter.transaction({ isolation: 'serializable' }, async (tx) => {
      for (const step of plan.steps) {
        for (const stmt of flatten(step)) await tx.execute(stmt)
        await tx.execute(
          meta(
            journalStepStatement(
              plan.id,
              step.id,
              step.phase,
              'applied',
              step.checksum,
              options.now,
            ),
          ),
        )
      }
      await tx.execute(meta(recordSchemaHashStatement(plan.toHash, options.now)))
    })
    return {
      status: before === null ? 'applied' : 'applied',
      planId: plan.id,
      stepsApplied: plan.steps.length,
      schemaHash: plan.toHash,
    }
  }

  // --- D1: lease + per-step journal + resume ---
  const holder = options.holder ?? `holder-${options.now}`
  if (!(await acquireLease(adapter, holder, options.now))) {
    throw new Error('SK_MIGRATION_LEASE: another migration is in progress')
  }
  let applied = 0
  let resumed = false
  try {
    const done = await appliedStepIds(adapter, plan.id)
    for (const step of plan.steps) {
      if (done.has(step.id) && (await postconditionHolds(adapter, step))) {
        resumed = true
        continue
      }
      await adapter.atomicBatch([
        ...flatten(step),
        journalStepStatement(plan.id, step.id, step.phase, 'applied', step.checksum, options.now),
      ])
      if (!(await postconditionHolds(adapter, step))) {
        throw new Error(`SK_MIGRATION_POSTCONDITION: step ${step.id} did not take effect`)
      }
      applied++
    }
    await adapter.atomicBatch([recordSchemaHashStatement(plan.toHash, options.now)])
  } finally {
    await releaseLease(adapter, holder)
  }
  return {
    status: resumed ? 'resumed' : 'applied',
    planId: plan.id,
    stepsApplied: applied,
    schemaHash: plan.toHash,
  }
}

function pgPlaceholders(stmt: SqlStatement): SqlStatement {
  let n = 0
  return { text: stmt.text.replace(/\?/g, () => `$${++n}`), parameters: stmt.parameters }
}

async function postconditionHolds(adapter: DatabaseAdapter, step: MigrationStep): Promise<boolean> {
  const pc = step.postcondition
  switch (pc.kind) {
    case 'none':
      return true
    case 'table-exists': {
      const r = await adapter.execute(
        sql(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, [pc.name]),
      )
      return r.rows.length > 0
    }
    case 'index-exists': {
      const r = await adapter.execute(
        sql(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?`, [pc.name]),
      )
      return r.rows.length > 0
    }
    case 'sequence-exists':
      return true
    case 'column-exists': {
      const [table, column] = pc.name.split('.') as [string, string]
      const r = await adapter.execute(sql(`PRAGMA table_info("${table}")`))
      return r.rows.some((row) => String(row.name) === column)
    }
    default:
      return true
  }
}

/**
 * Drift check (contract §17.1): compare the live database's normalized schema against the
 * desired IR. An unrecognised difference blocks with `SK_MIGRATION_DRIFT`.
 */
export function detectDrift(
  observed: ObservedSchema,
  desiredHash: string,
  observedHash: string,
): ReturnType<typeof kernelError> | null {
  if (observedHash === desiredHash) return null
  return kernelError({
    category: 'integrity',
    code: 'SK_MIGRATION_DRIFT',
    message: 'live schema does not match the desired schema; adopt or reconcile before migrating',
    httpStatus: 409,
    details: { observedTables: observed.tables.map((t) => t.name) },
  })
}

export function noopMigration(schema: ProjectSchema): ProjectSchema {
  return schema
}
