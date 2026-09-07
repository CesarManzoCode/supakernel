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
import {
  introspectPostgres,
  mapPostgresError,
  type PgQuery,
} from '@supakernel/db-postgres/pg-common'
import type { DatabaseAdapter } from '@supakernel/ports'

export interface PgliteAdapterOptions {
  /** `memory://` for an in-process database, or a directory path for on-disk persistence. */
  readonly dataDir: string
  readonly id?: string
}

type PgLiteLike = Pick<PGlite, 'query' | 'exec' | 'transaction' | 'close'>

function mapException(err: unknown): Error {
  const ke = mapPostgresError(err)
  const e = new Error(`${ke.code}: ${ke.message}`, { cause: err })
  ;(e as Error & { kernelError: unknown }).kernelError = ke
  return e
}

function isPgError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
}

async function runOn(db: PgLiteLike, statement: SqlStatement): Promise<DbResult> {
  try {
    const res = await db.query(statement.text, statement.parameters as unknown[])
    const rows = (res.rows as Array<Record<string, unknown>>).map((r) => ({ ...r }) as DbRow)
    return { rows, rowCount: res.affectedRows ?? rows.length }
  } catch (err) {
    throw mapException(err)
  }
}

class PgliteTransaction implements Transaction {
  readonly id: string
  private readonly tx: PgLiteLike

  constructor(id: string, tx: PgLiteLike) {
    this.id = id
    this.tx = tx
  }

  execute(statement: SqlStatement): Promise<DbResult> {
    return runOn(this.tx, statement)
  }
}

/**
 * PGlite adapter (contract §9.1). PGlite is treated as PostgreSQL — the *same* PG-family
 * connection contract, introspection and check parser as `db-postgres`; divergences from a
 * real server are named, never emulated away.
 */
export class PgliteAdapter implements DatabaseAdapter {
  readonly id: string
  readonly runtime = 'node' as const
  readonly capabilities: DatabaseCapabilities = {
    family: 'postgres',
    transactions: 'callback',
    ddlAtomicity: 'transactional',
    nativeRls: true,
    returning: true,
    json: 'native-jsonb',
    changeCapture: 'managed-triggers',
    // PGlite is a single-connection WASM build: it serializes everything and offers
    // serializable semantics only.
    isolation: ['serializable'],
  }

  private readonly db: PGlite
  private ready: Promise<void>
  private closed = false
  private txCounter = 0

  constructor(options: PgliteAdapterOptions) {
    this.id = options.id ?? `pglite:${options.dataDir}`
    this.db = new PGlite(options.dataDir)
    this.ready = this.db.waitReady.then(() => undefined)
  }

  async execute(statement: SqlStatement, tx?: Transaction): Promise<DbResult> {
    await this.ensureReady()
    if (tx) return tx.execute(statement)
    return runOn(this.db, statement)
  }

  async transaction<T>(
    options: TransactionOptions,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    await this.ensureReady()
    this.txCounter++
    const id = `pglitetx-${this.txCounter}`
    try {
      const result = await this.db.transaction(async (tx) => {
        for (const [k, v] of Object.entries(options.session ?? {})) {
          await tx.query('SELECT set_config($1, $2, true)', [k, v])
        }
        return fn(new PgliteTransaction(id, tx as unknown as PgLiteLike))
      })
      return result as T
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { kernelError?: unknown }).kernelError || !isPgError(err))
      ) {
        throw err
      }
      throw mapException(err)
    }
  }

  async atomicBatch(statements: readonly SqlStatement[]): Promise<readonly DbResult[]> {
    return this.transaction({ isolation: 'serializable' }, async (tx) => {
      const out: DbResult[] = []
      for (const s of statements) out.push(await tx.execute(s))
      return out
    })
  }

  async introspect(): Promise<ObservedSchema> {
    await this.ensureReady()
    const query: PgQuery = async (text, params) =>
      (await this.db.query(text, (params ?? []) as unknown[])).rows as Record<string, unknown>[]
    return introspectPostgres(query)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.db.close()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('SK_DB_CLOSED: adapter is closed')
    await this.ready
  }
}

export function openPglite(options: PgliteAdapterOptions): PgliteAdapter {
  return new PgliteAdapter(options)
}
