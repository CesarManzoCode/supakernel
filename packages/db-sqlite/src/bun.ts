// @supakernel/db-sqlite/bun — bun:sqlite entrypoint (ambient types in ./bun-sqlite.d.ts).
import { Database } from 'bun:sqlite'
import type { RuntimeId } from '@supakernel/contracts'
import { SqliteAdapter } from './core.js'
import type { PhysicalRow, PhysicalValue, SqliteDriver } from './driver.js'

class BunSqliteDriver implements SqliteDriver {
  readonly kind = 'bun' as const
  readonly supportsInteractiveTransactions = true
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 2000')
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql)
    return Promise.resolve()
  }

  all(sql: string, params: readonly PhysicalValue[]): Promise<PhysicalRow[]> {
    return Promise.resolve(this.db.prepare(sql).all(...params) as PhysicalRow[])
  }

  run(sql: string, params: readonly PhysicalValue[]): Promise<{ changes: number }> {
    const info = this.db.prepare(sql).run(...params)
    return Promise.resolve({ changes: Number(info.changes) })
  }

  async batch(
    statements: readonly { sql: string; params: readonly PhysicalValue[] }[],
  ): Promise<{ changes: number }[]> {
    const out: { changes: number }[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of statements) out.push(await this.run(s.sql, s.params))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return out
  }

  close(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }
}

export interface OpenBunSqliteOptions {
  readonly path: string
  readonly id?: string
  readonly runtime?: RuntimeId
}

export function openBunSqlite(options: OpenBunSqliteOptions): SqliteAdapter {
  return new SqliteAdapter({
    id: options.id ?? `sqlite-bun:${options.path}`,
    runtime: options.runtime ?? 'bun',
    driver: new BunSqliteDriver(options.path),
    transactionModel: 'interactive',
  })
}
