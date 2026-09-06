// @supakernel/db-sqlite/wasm — @sqlite.org/sqlite-wasm entrypoint for a browser WebWorker.
// Uses the OPFS SAHPool VFS so it needs no cross-origin isolation headers and persists to
// the Origin Private File System.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { RuntimeId } from '@supakernel/contracts'
import { SqliteAdapter } from './core.js'
import type { PhysicalRow, PhysicalValue, SqliteDriver } from './driver.js'

interface OpfsDb {
  exec(opts: {
    sql: string
    bind?: readonly unknown[]
    rowMode?: 'object'
    returnValue?: 'resultRows'
  }): unknown[]
  changes(): number
  close(): void
}

interface PoolUtil {
  OpfsSAHPoolDb: new (filename: string) => OpfsDb
  wipeFiles(): Promise<void>
}

let poolPromise: Promise<PoolUtil> | undefined

async function pool(vfsName: string): Promise<PoolUtil> {
  if (!poolPromise) {
    poolPromise = sqlite3InitModule().then((sqlite3: unknown) =>
      (
        sqlite3 as { installOpfsSAHPoolVfs: (o: { name: string }) => Promise<PoolUtil> }
      ).installOpfsSAHPoolVfs({ name: vfsName }),
    )
  }
  return poolPromise
}

function toPhysicalRow(row: Record<string, unknown>): PhysicalRow {
  const out: Record<string, PhysicalValue> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      v instanceof Uint8Array
        ? v
        : v === null || typeof v === 'number' || typeof v === 'string'
          ? (v as PhysicalValue)
          : typeof v === 'bigint'
            ? v.toString()
            : v === undefined
              ? null
              : String(v)
  }
  return out
}

class WasmSqliteDriver implements SqliteDriver {
  readonly kind = 'wasm' as const
  readonly supportsInteractiveTransactions = true
  private readonly db: OpfsDb

  private constructor(db: OpfsDb) {
    this.db = db
  }

  static async open(filename: string, vfsName: string): Promise<WasmSqliteDriver> {
    const p = await pool(vfsName)
    const db = new p.OpfsSAHPoolDb(filename)
    db.exec({ sql: 'PRAGMA foreign_keys = ON' })
    return new WasmSqliteDriver(db)
  }

  exec(sql: string): Promise<void> {
    this.db.exec({ sql })
    return Promise.resolve()
  }

  all(sql: string, params: readonly PhysicalValue[]): Promise<PhysicalRow[]> {
    const rows = this.db.exec({
      sql,
      bind: params,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, unknown>[]
    return Promise.resolve(rows.map(toPhysicalRow))
  }

  run(sql: string, params: readonly PhysicalValue[]): Promise<{ changes: number }> {
    this.db.exec({ sql, bind: params })
    return Promise.resolve({ changes: this.db.changes() })
  }

  async batch(
    statements: readonly { sql: string; params: readonly PhysicalValue[] }[],
  ): Promise<{ changes: number }[]> {
    const out: { changes: number }[] = []
    this.db.exec({ sql: 'BEGIN IMMEDIATE' })
    try {
      for (const s of statements) out.push(await this.run(s.sql, s.params))
      this.db.exec({ sql: 'COMMIT' })
    } catch (err) {
      this.db.exec({ sql: 'ROLLBACK' })
      throw err
    }
    return out
  }

  close(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }
}

export interface OpenWasmSqliteOptions {
  /** OPFS filename, e.g. `/contract.sqlite3`. */
  readonly filename: string
  readonly vfsName?: string
  readonly id?: string
  readonly runtime?: RuntimeId
}

export async function openWasmSqlite(options: OpenWasmSqliteOptions): Promise<SqliteAdapter> {
  const driver = await WasmSqliteDriver.open(options.filename, options.vfsName ?? 'supakernel-opfs')
  return new SqliteAdapter({
    id: options.id ?? `sqlite-wasm:${options.filename}`,
    runtime: options.runtime ?? 'browser',
    driver,
    transactionModel: 'interactive',
  })
}

/** Delete every OPFS file the SAHPool owns — used by the harness between cases. */
export async function wipeWasmOpfs(vfsName = 'supakernel-opfs'): Promise<void> {
  const p = await pool(vfsName)
  await p.wipeFiles()
}
