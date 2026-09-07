import { type SqlStatement, sql } from '@supakernel/contracts'
import type { PostgresAdapter } from '@supakernel/db-postgres'

/**
 * Apply the compiled RLS statements inside one transaction guarded by a transaction-level
 * advisory lock, so parallel test files that share the `sk` helper schema and the roles do not
 * race on `CREATE OR REPLACE FUNCTION` (`tuple concurrently updated`).
 */
export async function deployRls(
  db: PostgresAdapter,
  statements: readonly SqlStatement[],
): Promise<void> {
  await db.transaction({ isolation: 'serializable' }, async (tx) => {
    await tx.execute(sql('SELECT pg_advisory_xact_lock(424242)'))
    for (const s of statements) await tx.execute(s)
  })
}
