import { type DbRow, type Family, sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { validateManagementQuery } from './query.js'

function table(family: Family): string {
  return family === 'postgres' ? '_supakernel.migrations' : '_supakernel_migrations'
}

export async function ensureMigrationTable(adapter: DatabaseAdapter): Promise<void> {
  const family = adapter.capabilities.family
  const ts = family === 'postgres' ? 'timestamptz' : 'TEXT'
  const txt = family === 'postgres' ? 'text' : 'TEXT'
  if (family === 'postgres') await adapter.execute(sql('CREATE SCHEMA IF NOT EXISTS _supakernel'))
  await adapter.execute(
    sql(`CREATE TABLE IF NOT EXISTS ${table(family)} (
      version ${txt} PRIMARY KEY,
      name ${txt} NOT NULL,
      statements ${txt} NOT NULL,
      applied_at ${ts} NOT NULL
    )`),
  )
}

export async function listMigrations(adapter: DatabaseAdapter): Promise<DbRow[]> {
  await ensureMigrationTable(adapter)
  const r = await adapter.execute(
    sql(
      `SELECT version, name, applied_at FROM ${table(adapter.capabilities.family)} ORDER BY version`,
    ),
  )
  return [...r.rows]
}

/** Apply a migration transactionally and record it (contract §16). */
export async function applyMigration(
  adapter: DatabaseAdapter,
  input: { name: string; query: string; version?: string },
): Promise<{ version: string; name: string }> {
  await ensureMigrationTable(adapter)
  const family = adapter.capabilities.family
  const version =
    input.version ??
    new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14)
  // one DDL/DML statement per call, no filesystem / network functions
  const stmt = validateManagementQuery(input.query, { readOnly: false, timeoutMs: 30_000 })
  const ph = (n: number): string =>
    Array.from({ length: n }, (_, i) => (family === 'postgres' ? `$${i + 1}` : '?')).join(',')

  await adapter.transaction({ isolation: 'serializable' }, async (tx) => {
    await tx.execute(sql(stmt))
    await tx.execute(
      sql(
        `INSERT INTO ${table(family)} (version, name, statements, applied_at) VALUES (${ph(4)})`,
        [version, input.name, stmt, new Date().toISOString()],
      ),
    )
  })
  return { version, name: input.name }
}
