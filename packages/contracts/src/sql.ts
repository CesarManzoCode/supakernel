import type { Json } from './json.js'

/**
 * A parameterized statement. `text` may contain dialect placeholders and, as the single
 * permitted interpolation, identifiers that were validated against `SchemaIR` and quoted by
 * the dialect (contract §6.1, §9.2). `parameters` are always bound, never inlined.
 *
 * Physical parameter values are the portable set the adapters agree on: `bigint` for logical
 * int64 in the core, marshalled to a canonical decimal string by the SQLite-family dialect
 * before it reaches the driver.
 */
export interface SqlStatement {
  readonly text: string
  readonly parameters: readonly SqlValue[]
}

export type SqlValue = null | boolean | number | bigint | string | Uint8Array

export interface DbRow {
  readonly [column: string]: SqlValue | Json
}

export interface DbResult {
  readonly rows: readonly DbRow[]
  readonly rowCount: number
}

export type IsolationLevel = 'read-committed' | 'serializable'

export interface TransactionOptions {
  readonly isolation: IsolationLevel
  readonly readOnly?: boolean
  /** GUC / session settings applied for the lifetime of the transaction (e.g. role, claims). */
  readonly session?: Readonly<Record<string, string>>
}

/** A handle to an open transaction. Adapters implement it; services receive it. */
export interface Transaction {
  readonly id: string
  execute(statement: SqlStatement): Promise<DbResult>
}

export function sql(text: string, parameters: readonly SqlValue[] = []): SqlStatement {
  return { text, parameters }
}
