import type {
  DatabaseCapabilities,
  DbResult,
  DbRow,
  ObservedSchema,
  SqlStatement,
  Transaction,
  TransactionOptions,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import postgres from 'postgres'
import { mapPostgresError } from './errors.js'
import { introspectPostgres, type PgQuery } from './introspect.js'

export interface PostgresAdapterOptions {
  readonly url: string
  readonly id?: string
  /** Applied per connection; the pool is kept small so the connection contract is observable. */
  readonly max?: number
}

type Sql = ReturnType<typeof postgres>

function toParam(value: SqlStatement['parameters'][number]): unknown {
  // postgres.js handles bigint, Uint8Array, null, string, number, boolean natively.
  return value
}

function isPgError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
}

function mapException(err: unknown): Error {
  const ke = mapPostgresError(err)
  const e = new Error(`${ke.code}: ${ke.message}`, { cause: err })
  ;(e as Error & { kernelError: unknown }).kernelError = ke
  return e
}

async function runOn(sql: Sql, statement: SqlStatement): Promise<DbResult> {
  try {
    const rows = (await sql.unsafe(
      statement.text,
      statement.parameters.map(toParam) as never[],
    )) as unknown as Array<Record<string, unknown>>
    const count = (rows as { count?: number }).count ?? rows.length
    return { rows: rows.map((r) => ({ ...r }) as DbRow), rowCount: count }
  } catch (err) {
    throw mapException(err)
  }
}

class PgTransaction implements Transaction {
  readonly id: string
  private readonly sql: Sql

  constructor(id: string, sql: Sql) {
    this.id = id
    this.sql = sql
  }

  execute(statement: SqlStatement): Promise<DbResult> {
    return runOn(this.sql, statement)
  }
}

/**
 * `postgres.js` adapter for PostgreSQL 18.6 (contract §9.1). Drivers only: the IR, planner and
 * dialect are ours. Every authenticated request runs in its own transaction upstream; this
 * adapter exposes the primitive `execute` / `transaction` / `atomicBatch` surface.
 */
export class PostgresAdapter implements DatabaseAdapter {
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
    isolation: ['read-committed', 'serializable'],
  }

  private readonly sql: Sql
  private closed = false
  private txCounter = 0

  constructor(options: PostgresAdapterOptions) {
    this.id = options.id ?? 'postgres.js'
    this.sql = postgres(options.url, {
      max: options.max ?? 4,
      prepare: false,
      onnotice: () => undefined,
      types: {
        // keep int8 as an exact decimal string; the dialect marshals to bigint
        bigint: postgres.BigInt,
      },
    })
  }

  async execute(statement: SqlStatement, tx?: Transaction): Promise<DbResult> {
    this.assertOpen()
    if (tx) return tx.execute(statement)
    return runOn(this.sql, statement)
  }

  async transaction<T>(
    options: TransactionOptions,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    const mode =
      options.isolation === 'serializable'
        ? 'isolation level serializable'
        : 'isolation level read committed'
    this.txCounter++
    const id = `pgtx-${this.txCounter}`
    try {
      return (await this.sql.begin(mode, async (txSql) => {
        if (options.readOnly) await txSql.unsafe('SET TRANSACTION READ ONLY')
        for (const [k, v] of Object.entries(options.session ?? {})) {
          await txSql.unsafe(`SELECT set_config($1, $2, true)`, [k, v])
        }
        return fn(new PgTransaction(id, txSql as unknown as Sql))
      })) as T
    } catch (err) {
      // A user error thrown inside the callback (or an already-mapped one) propagates as-is;
      // only a raw driver failure is mapped.
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
    this.assertOpen()
    const query: PgQuery = async (text, params) =>
      (await this.sql.unsafe(text, (params ?? []) as never[])) as unknown as Record<
        string,
        unknown
      >[]
    return introspectPostgres(query)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.sql.end({ timeout: 5 })
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SK_DB_CLOSED: adapter is closed')
  }
}

export function openPostgres(options: PostgresAdapterOptions): PostgresAdapter {
  return new PostgresAdapter(options)
}
