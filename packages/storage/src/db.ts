import {
  type DbRow,
  type Family,
  type SqlValue,
  sql,
  type Transaction,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'

export function storageTable(name: 'buckets' | 'objects', family: Family): string {
  return family === 'postgres' ? `storage.${name}` : `storage_${name}`
}

/** Object consistency states (contract §14.2). */
export type ObjectState = 'staging' | 'ready' | 'deleting' | 'corrupt'

export class StorageDb {
  readonly adapter: DatabaseAdapter
  readonly family: Family
  constructor(adapter: DatabaseAdapter, family: Family) {
    this.adapter = adapter
    this.family = family
  }
  private t(s: string): string {
    if (this.family !== 'postgres') return s
    let i = 0
    return s.replace(/\?/g, () => `$${++i}`)
  }
  async run(s: string, p: readonly SqlValue[] = [], tx?: Transaction): Promise<number> {
    const stmt = sql(this.t(s), p)
    return (tx ? await tx.execute(stmt) : await this.adapter.execute(stmt)).rowCount
  }
  async all(s: string, p: readonly SqlValue[] = [], tx?: Transaction): Promise<DbRow[]> {
    const stmt = sql(this.t(s), p)
    return [...(tx ? await tx.execute(stmt) : await this.adapter.execute(stmt)).rows]
  }
  async one(s: string, p: readonly SqlValue[] = [], tx?: Transaction): Promise<DbRow | null> {
    return (await this.all(s, p, tx))[0] ?? null
  }
  tx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.adapter.transaction({ isolation: 'serializable' }, fn)
  }
}

export function storageSchemaStatements(family: Family): string[] {
  const pg = family === 'postgres'
  const B = storageTable('buckets', family)
  const O = storageTable('objects', family)
  const ts = pg ? 'timestamptz' : 'TEXT'
  const bool = pg ? 'boolean' : 'INTEGER'
  const txt = pg ? 'text' : 'TEXT'
  const i64 = pg ? 'bigint' : 'SK_TEXT_I64'
  const out: string[] = []
  if (pg) out.push('CREATE SCHEMA IF NOT EXISTS storage')
  out.push(`DROP TABLE IF EXISTS ${O}`)
  out.push(`DROP TABLE IF EXISTS ${B}`)
  out.push(`CREATE TABLE ${B} (
    id ${txt} PRIMARY KEY,
    name ${txt} NOT NULL UNIQUE,
    public ${bool} NOT NULL DEFAULT ${pg ? 'false' : '0'},
    file_size_limit ${i64},
    allowed_mime_types ${txt},
    owner ${txt},
    created_at ${ts} NOT NULL,
    updated_at ${ts} NOT NULL
  )`)
  out.push(`CREATE TABLE ${O} (
    id ${txt} PRIMARY KEY,
    bucket_id ${txt} NOT NULL REFERENCES ${B}(id) ON DELETE CASCADE,
    name ${txt} NOT NULL,
    state ${txt} NOT NULL,
    op_id ${txt},
    size ${i64},
    sha256 ${txt},
    content_type ${txt},
    cache_control ${txt},
    owner ${txt},
    metadata ${txt} NOT NULL DEFAULT '{}',
    version ${txt} NOT NULL,
    created_at ${ts} NOT NULL,
    updated_at ${ts} NOT NULL
  )`)
  out.push(`CREATE UNIQUE INDEX sk_obj_bucket_name_ver ON ${O} (bucket_id, name, version)`)
  return out
}
