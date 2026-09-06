import { type SqlStatement, sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'

/**
 * Migration journal (contract §17.1). For transactional adapters the journal is written in the
 * same transaction as the effects. For D1 (no distributed transaction) each step is journaled
 * individually with a lease and an idempotent, observable postcondition, so a crashed run
 * resumes from the first step whose postcondition is not yet satisfied.
 */
export type StepState = 'pending' | 'running' | 'applied' | 'compensated' | 'failed'

export const JOURNAL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _sk_migration_lease (
     id TEXT PRIMARY KEY,
     holder TEXT NOT NULL,
     acquired_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS _sk_migration_journal (
     plan_id TEXT NOT NULL,
     step_id TEXT NOT NULL,
     phase TEXT NOT NULL,
     state TEXT NOT NULL,
     checksum TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (plan_id, step_id)
   )`,
  `CREATE TABLE IF NOT EXISTS _sk_schema_lock (
     id TEXT PRIMARY KEY,
     schema_hash TEXT NOT NULL,
     applied_at TEXT NOT NULL
   )`,
]

export async function ensureJournal(adapter: DatabaseAdapter): Promise<void> {
  for (const ddl of JOURNAL_DDL) await adapter.execute(sql(ddl))
}

export async function currentSchemaHash(adapter: DatabaseAdapter): Promise<string | null> {
  const res = await adapter.execute(
    sql(`SELECT schema_hash FROM _sk_schema_lock WHERE id = 'current'`),
  )
  const row = res.rows[0]
  return row ? String(row.schema_hash) : null
}

export function recordSchemaHashStatement(hash: string, now: string): SqlStatement {
  return sql(
    `INSERT INTO _sk_schema_lock (id, schema_hash, applied_at) VALUES ('current', ?, ?)
     ON CONFLICT (id) DO UPDATE SET schema_hash = excluded.schema_hash, applied_at = excluded.applied_at`,
    [hash, now],
  )
}

export function journalStepStatement(
  planId: string,
  stepId: string,
  phase: string,
  state: StepState,
  checksum: string,
  now: string,
): SqlStatement {
  return sql(
    `INSERT INTO _sk_migration_journal (plan_id, step_id, phase, state, checksum, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (plan_id, step_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    [planId, stepId, phase, state, checksum, now],
  )
}

export async function acquireLease(
  adapter: DatabaseAdapter,
  holder: string,
  now: string,
): Promise<boolean> {
  try {
    await adapter.execute(
      sql(`INSERT INTO _sk_migration_lease (id, holder, acquired_at) VALUES ('migration', ?, ?)`, [
        holder,
        now,
      ]),
    )
    return true
  } catch {
    // A stale lease older than 10 minutes may be taken over.
    const res = await adapter.execute(
      sql(`SELECT acquired_at FROM _sk_migration_lease WHERE id = 'migration'`),
    )
    const acquiredAt = res.rows[0] ? Date.parse(String(res.rows[0].acquired_at)) : Date.now()
    if (Date.now() - acquiredAt > 600_000) {
      await adapter.execute(
        sql(`UPDATE _sk_migration_lease SET holder = ?, acquired_at = ? WHERE id = 'migration'`, [
          holder,
          now,
        ]),
      )
      return true
    }
    return false
  }
}

export async function releaseLease(adapter: DatabaseAdapter, holder: string): Promise<void> {
  await adapter.execute(
    sql(`DELETE FROM _sk_migration_lease WHERE id = 'migration' AND holder = ?`, [holder]),
  )
}

export async function appliedStepIds(
  adapter: DatabaseAdapter,
  planId: string,
): Promise<Set<string>> {
  const res = await adapter.execute(
    sql(`SELECT step_id FROM _sk_migration_journal WHERE plan_id = ? AND state = 'applied'`, [
      planId,
    ]),
  )
  return new Set(res.rows.map((r) => String(r.step_id)))
}
