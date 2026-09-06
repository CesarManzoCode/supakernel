import type { SqlValue } from '@supakernel/contracts'

/**
 * The minimal surface every SQLite binding exposes. The four entrypoints (node / bun / d1 /
 * wasm) each provide one of these; `core.ts` builds the `DatabaseAdapter` on top and is the
 * single place SQLite semantics live.
 *
 * Values crossing this boundary are already physical: `bigint` has been marshalled to a
 * canonical decimal string by `core.ts` before it reaches a driver, and the driver returns
 * whatever SQLite stored (TEXT as string, BLOB as Uint8Array, NULL as null).
 */
export interface SqliteDriver {
  readonly kind: 'node' | 'bun' | 'd1' | 'wasm'
  /** Whether this binding can run `BEGIN`/`COMMIT` (all but D1, which uses atomic batch). */
  readonly supportsInteractiveTransactions: boolean
  exec(sql: string): Promise<void>
  all(sql: string, params: readonly PhysicalValue[]): Promise<PhysicalRow[]>
  run(sql: string, params: readonly PhysicalValue[]): Promise<{ changes: number }>
  /** Run several statements as one indivisible unit (D1 native; emulated with a tx elsewhere). */
  batch(
    statements: readonly { sql: string; params: readonly PhysicalValue[] }[],
  ): Promise<{ changes: number }[]>
  close(): Promise<void>
}

export type PhysicalValue = null | number | string | Uint8Array
export interface PhysicalRow {
  readonly [column: string]: PhysicalValue
}

export function toPhysical(value: SqlValue): PhysicalValue {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}
