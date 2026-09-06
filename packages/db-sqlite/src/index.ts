// SupaKernel SQLite family: one core, four bindings (node / bun / d1 / wasm).
// See docs/SupaKernel-Contract.md §9.

export { parseSqliteCheck, UnsupportedCheckError } from './check-parser.ts'
export { SqliteAdapter, type SqliteAdapterOptions } from './core.ts'
export {
  isDecimalStringType,
  numericRef,
  portableTypeForSqlite,
  quoteIdent,
  sqliteTypeFor,
} from './dialect.ts'
export type { PhysicalRow, PhysicalValue, SqliteDriver } from './driver.ts'
export { toPhysical } from './driver.ts'
export { mapSqliteError } from './errors.ts'
export { introspectSqlite } from './introspect.ts'
