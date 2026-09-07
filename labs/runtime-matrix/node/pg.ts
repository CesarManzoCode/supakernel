import { openPostgres } from '@supakernel/db-postgres'
import type { DatabaseAdapter } from '@supakernel/ports'

/** The admin Postgres URL, or `null` when the suite runs without a real PG (contract §31). */
export function adminPgUrl(): string | null {
  return process.env.SUPAKERNEL_TEST_PG_URL ?? null
}

export interface FreshPgDatabase {
  readonly adapter: DatabaseAdapter
  drop(): Promise<void>
}

/**
 * Create a throwaway database so a runtime profile's kernel (auth.*, storage.*, _supakernel.*)
 * never races the other Postgres suites. Real PG 18.6.
 */
export async function createFreshPgDatabase(adminUrl: string): Promise<FreshPgDatabase> {
  const name = `sk_rtm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const admin = openPostgres({ url: adminUrl, id: 'rtm-admin' })
  await admin.execute({ text: `CREATE DATABASE "${name}"`, parameters: [] })
  await admin.close()

  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const adapter = openPostgres({ url: url.toString(), id: `rtm-${name}` })
  return {
    adapter,
    drop: async () => {
      await adapter.close().catch(() => undefined)
      const a = openPostgres({ url: adminUrl, id: 'rtm-drop' })
      await a
        .execute({ text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, parameters: [] })
        .catch(() => undefined)
      await a.close()
    },
  }
}
