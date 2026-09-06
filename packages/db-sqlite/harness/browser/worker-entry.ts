/**
 * Dedicated WebWorker that runs the shared Database connection contract suite inside real
 * Chromium against a real OPFS-backed database (contract §30 L2, "real Chromium + real
 * dedicated WebWorker", two profiles).
 *
 * Profiles:
 *  - `sqlite-wasm`: @sqlite.org/sqlite-wasm@3.53.0-build1 + OPFS SAHPool VFS
 *  - `pglite`:      @electric-sql/pglite@0.5.8 + OPFS access-handle-pool persistence
 */
import { PGlite } from '@electric-sql/pglite'
import type {
  DatabaseCapabilities,
  DbResult,
  DbRow,
  ObservedSchema,
  SqlStatement,
  Transaction,
  TransactionOptions,
} from '@supakernel/contracts'
import { introspectPostgres, mapPostgresError } from '@supakernel/db-postgres/pg-common'
import type { DatabaseAdapter } from '@supakernel/ports'
import { type DatabaseContractHarness, runDatabaseContractSuite } from '@supakernel/ports-test'
import { openWasmSqlite, wipeWasmOpfs } from '../../src/wasm.js'
import { type CaseResult, createCollectorApi } from './mini-runner.js'

function wrapPgError(err: unknown): Error {
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return err as Error
  const ke = mapPostgresError(err)
  const e = new Error(`${ke.code}: ${ke.message}`)
  ;(e as Error & { kernelError: unknown }).kernelError = ke
  return e
}

// --- PGlite adapter, browser flavour (single-connection, serializable) ---

class BrowserPgliteAdapter implements DatabaseAdapter {
  readonly id = 'pglite-browser'
  readonly runtime = 'browser' as const
  readonly capabilities: DatabaseCapabilities = {
    family: 'postgres',
    transactions: 'callback',
    ddlAtomicity: 'transactional',
    nativeRls: true,
    returning: true,
    json: 'native-jsonb',
    changeCapture: 'managed-triggers',
    isolation: ['serializable'],
  }
  private db: PGlite
  private closed = false

  constructor(dataDir: string) {
    this.db = new PGlite(dataDir)
  }

  async execute(statement: SqlStatement, tx?: Transaction): Promise<DbResult> {
    if (tx) return tx.execute(statement)
    try {
      const res = await this.db.query(statement.text, statement.parameters as unknown[])
      return {
        rows: (res.rows as Array<Record<string, unknown>>).map((r) => ({ ...r }) as DbRow),
        rowCount: res.affectedRows ?? res.rows.length,
      }
    } catch (err) {
      throw wrapPgError(err)
    }
  }

  async transaction<T>(_o: TransactionOptions, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return (await this.db.transaction(async (t) => {
      const tx: Transaction = {
        id: 'pglite-browser-tx',
        execute: async (s) => {
          const res = await t.query(s.text, s.parameters as unknown[])
          return {
            rows: (res.rows as Array<Record<string, unknown>>).map((r) => ({ ...r }) as DbRow),
            rowCount: res.affectedRows ?? res.rows.length,
          }
        },
      }
      return fn(tx)
    })) as T
  }

  async atomicBatch(statements: readonly SqlStatement[]): Promise<readonly DbResult[]> {
    return this.transaction({ isolation: 'serializable' }, async (tx) => {
      const out: DbResult[] = []
      for (const s of statements) out.push(await tx.execute(s))
      return out
    })
  }

  async introspect(): Promise<ObservedSchema> {
    return introspectPostgres(
      async (text, params) =>
        (await this.db.query(text, (params ?? []) as unknown[])).rows as Record<string, unknown>[],
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.db.close()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

// --- harness selection ---

function sqliteWasmHarness(): DatabaseContractHarness {
  const filename = '/sk-contract.sqlite3'
  return {
    label: 'SQLite-WASM + OPFS (Chromium WebWorker)',
    open: () => openWasmSqlite({ filename }),
    reopen: () => openWasmSqlite({ filename }),
    cleanup: () => wipeWasmOpfs(),
  }
}

function pgliteHarness(): DatabaseContractHarness {
  const dir = 'opfs-ahp://sk-pglite-contract'
  // OPFS access handles are exclusive: a "crash + reopen" for a single-connection engine is
  // modelled by releasing the prior handle first, which is what a real process restart does.
  let current: BrowserPgliteAdapter | undefined
  const spawn = async (): Promise<BrowserPgliteAdapter> => {
    if (current) await current.close().catch(() => undefined)
    current = new BrowserPgliteAdapter(dir)
    return current
  }
  return {
    label: 'PGlite + OPFS persistence (Chromium WebWorker)',
    open: spawn,
    reopen: spawn,
    cleanup: async () => {
      const scratch = new BrowserPgliteAdapter(dir)
      const tables = await scratch.execute({
        text: `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
        parameters: [],
      })
      for (const row of tables.rows) {
        await scratch.execute({
          text: `DROP TABLE IF EXISTS "${String(row.tablename)}" CASCADE`,
          parameters: [],
        })
      }
      await scratch.execute({
        text: `DROP FUNCTION IF EXISTS ct_outbox_fn() CASCADE`,
        parameters: [],
      })
      await scratch.close()
    },
  }
}

self.addEventListener('message', async (event: MessageEvent) => {
  const profile = (event.data as { profile: 'sqlite-wasm' | 'pglite' }).profile
  try {
    const { api, run } = createCollectorApi()
    runDatabaseContractSuite(api, profile === 'pglite' ? pgliteHarness() : sqliteWasmHarness())
    const results: CaseResult[] = await run()
    self.postMessage({ ok: true, profile, results })
  } catch (err) {
    self.postMessage({ ok: false, profile, error: (err as Error).message ?? String(err) })
  }
})

self.postMessage({ ready: true })
