import {
  type DatabaseCapabilities,
  type DbResult,
  type DbRow,
  kernelError,
  type ObservedSchema,
  type RuntimeId,
  type SqlStatement,
  type Transaction,
  type TransactionOptions,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { type PhysicalRow, type SqliteDriver, toPhysical } from './driver.js'
import { mapSqliteError } from './errors.js'
import { introspectSqlite } from './introspect.js'

export interface SqliteAdapterOptions {
  readonly id: string
  readonly runtime: RuntimeId
  readonly driver: SqliteDriver
  /** D1 has no interactive `BEGIN`; it exposes an atomic batch instead. */
  readonly transactionModel: 'interactive' | 'atomic-batch'
}

const WANTS_ROWS = /^\s*(select|with|pragma|explain)\b/i
const HAS_RETURNING = /\breturning\b/i

function rowFromPhysical(row: PhysicalRow): DbRow {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = v
  return out as DbRow
}

class SqliteTransaction implements Transaction {
  readonly id: string
  private readonly driver: SqliteDriver

  constructor(id: string, driver: SqliteDriver) {
    this.id = id
    this.driver = driver
  }

  async execute(statement: SqlStatement): Promise<DbResult> {
    return runOne(this.driver, statement)
  }
}

async function runOne(driver: SqliteDriver, statement: SqlStatement): Promise<DbResult> {
  const params = statement.parameters.map(toPhysical)
  try {
    if (WANTS_ROWS.test(statement.text) || HAS_RETURNING.test(statement.text)) {
      const rows = await driver.all(statement.text, params)
      return { rows: rows.map(rowFromPhysical), rowCount: rows.length }
    }
    const res = await driver.run(statement.text, params)
    return { rows: [], rowCount: res.changes }
  } catch (err) {
    throw mapToException(err)
  }
}

function mapToException(err: unknown): Error {
  const ke = mapSqliteError(err)
  const e = new Error(`${ke.code}: ${ke.message}`, { cause: err })
  ;(e as Error & { kernelError: unknown }).kernelError = ke
  return e
}

export class SqliteAdapter implements DatabaseAdapter {
  readonly id: string
  readonly runtime: RuntimeId
  readonly capabilities: DatabaseCapabilities

  private readonly driver: SqliteDriver
  private readonly transactionModel: 'interactive' | 'atomic-batch'
  private closed = false
  private txDepth = 0
  private txCounter = 0

  constructor(options: SqliteAdapterOptions) {
    this.id = options.id
    this.runtime = options.runtime
    this.driver = options.driver
    this.transactionModel = options.transactionModel
    this.capabilities = {
      family: 'sqlite',
      transactions: options.transactionModel === 'interactive' ? 'callback' : 'atomic-batch',
      ddlAtomicity: options.transactionModel === 'interactive' ? 'transactional' : 'step-journal',
      nativeRls: false,
      returning: true,
      json: 'json-text',
      changeCapture: 'managed-triggers',
      isolation: ['serializable'],
    }
  }

  async execute(statement: SqlStatement, tx?: Transaction): Promise<DbResult> {
    this.assertOpen()
    if (tx) return tx.execute(statement)
    return runOne(this.driver, statement)
  }

  async transaction<T>(
    _options: TransactionOptions,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    this.assertOpen()
    if (this.transactionModel !== 'interactive') {
      throw new Error(
        'SK_CAPABILITY: this SQLite binding has no interactive transaction; use atomicBatch',
      )
    }
    if (this.txDepth > 0) {
      throw kernelException('SK_DB_NESTED_TX', 'nested transactions are not supported')
    }
    this.txDepth++
    this.txCounter++
    const tx = new SqliteTransaction(`tx-${this.txCounter}`, this.driver)
    // SQLite writes use BEGIN IMMEDIATE (contract §9.2).
    await this.driver.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(tx)
      await this.driver.exec('COMMIT')
      return result
    } catch (err) {
      try {
        await this.driver.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    } finally {
      this.txDepth--
    }
  }

  async atomicBatch(statements: readonly SqlStatement[]): Promise<readonly DbResult[]> {
    this.assertOpen()
    if (this.transactionModel === 'interactive') {
      return this.transaction({ isolation: 'serializable' }, async (tx) => {
        const out: DbResult[] = []
        for (const s of statements) out.push(await tx.execute(s))
        return out
      })
    }
    // D1 native atomic batch.
    try {
      const results = await this.driver.batch(
        statements.map((s) => ({ sql: s.text, params: s.parameters.map(toPhysical) })),
      )
      return results.map((r) => ({ rows: [], rowCount: r.changes }))
    } catch (err) {
      throw mapToException(err)
    }
  }

  async introspect(): Promise<ObservedSchema> {
    this.assertOpen()
    return introspectSqlite(this.driver)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.driver.close()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertOpen(): void {
    if (this.closed) throw kernelException('SK_DB_CLOSED', 'adapter is closed')
  }
}

function kernelException(code: string, message: string): Error {
  const e = new Error(`${code}: ${message}`)
  ;(e as Error & { kernelError: unknown }).kernelError = kernelError({
    category: 'capability',
    code,
    message,
    httpStatus: 409,
  })
  return e
}
