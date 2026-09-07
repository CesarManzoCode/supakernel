import { type SqlStatement, sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'

/** Deploy RLS inside one advisory-locked transaction so parallel test files don't race. */
export async function deployRls(
  db: DatabaseAdapter,
  statements: readonly SqlStatement[],
): Promise<void> {
  await db.transaction({ isolation: 'serializable' }, async (tx) => {
    await tx.execute(sql('SELECT pg_advisory_xact_lock(424242)'))
    for (const s of statements) await tx.execute(s)
  })
}
