import { DatabaseSync } from 'node:sqlite'
import type { RuntimeId } from '@supakernel/contracts'
import { SqliteAdapter } from './core.js'
import type { PhysicalRow, PhysicalValue, SqliteDriver } from './driver.js'

/** `node:sqlite` (Node 24) driver. Synchronous binding wrapped in the async `SqliteDriver`. */
class NodeSqliteDriver implements SqliteDriver {
  readonly kind = 'node' as const
  readonly supportsInteractiveTransactions = true
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 2000')
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql)
    return Promise.resolve()
  }

  all(sql: string, params: readonly PhysicalValue[]): Promise<PhysicalRow[]> {
    const stmt = this.db.prepare(sql)
    const rows = stmt.all(...(params as PhysicalValue[])) as PhysicalRow[]
    return Promise.resolve(rows)
  }

  run(sql: string, params: readonly PhysicalValue[]): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql)
    const info = stmt.run(...(params as PhysicalValue[]))
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

export interface OpenNodeSqliteOptions {
  /** File path, or `:memory:` for an in-process database. */
  readonly path: string
  readonly id?: string
  readonly runtime?: RuntimeId
}

export function openNodeSqlite(options: OpenNodeSqliteOptions): SqliteAdapter {
  return new SqliteAdapter({
    id: options.id ?? `sqlite-node:${options.path}`,
    runtime: options.runtime ?? 'node',
    driver: new NodeSqliteDriver(options.path),
    transactionModel: 'interactive',
  })
}
