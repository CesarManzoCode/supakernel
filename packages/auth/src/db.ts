import {
  type DbRow,
  type Family,
  type SqlValue,
  sql,
  type Transaction,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'

/**
 * A thin, family-aware access layer for the `auth_*` tables (contract §12.2). Statements are
 * written with `?` placeholders; PostgreSQL gets `$n` translation. All auth state lives in
 * dedicated tables managed here — never through the Data layer.
 */
export class AuthDb {
  readonly adapter: DatabaseAdapter
  readonly family: Family
  constructor(adapter: DatabaseAdapter, family: Family) {
    this.adapter = adapter
    this.family = family
  }

  private text(t: string): string {
    if (this.family !== 'postgres') return t
    let i = 0
    return t.replace(/\?/g, () => `$${++i}`)
  }

  async run(t: string, params: readonly SqlValue[] = [], tx?: Transaction): Promise<number> {
    const stmt = sql(this.text(t), params)
    const res = tx ? await tx.execute(stmt) : await this.adapter.execute(stmt)
    return res.rowCount
  }

  async all(t: string, params: readonly SqlValue[] = [], tx?: Transaction): Promise<DbRow[]> {
    const stmt = sql(this.text(t), params)
    const res = tx ? await tx.execute(stmt) : await this.adapter.execute(stmt)
    return [...res.rows]
  }

  async one(t: string, params: readonly SqlValue[] = [], tx?: Transaction): Promise<DbRow | null> {
    const rows = await this.all(t, params, tx)
    return rows[0] ?? null
  }

  /** Serializable transaction (refresh CAS, session revocation) — contract §9.2. */
  tx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.adapter.transaction({ isolation: 'serializable' }, fn)
  }
}

export function boolValue(family: Family, v: boolean): SqlValue {
  return family === 'postgres' ? v : v ? 1 : 0
}

export function readBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true'
}
