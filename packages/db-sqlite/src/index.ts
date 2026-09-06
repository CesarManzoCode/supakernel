// SupaKernel SQLite family: one core, four bindings (node / bun / d1 / wasm).
// See docs/SupaKernel-Contract.md §9.

export { parseSqliteCheck, UnsupportedCheckError } from './check-parser.js'
export { SqliteAdapter, type SqliteAdapterOptions } from './core.js'
export {
  isDecimalStringType,
  numericRef,
  portableTypeForSqlite,
  quoteIdent,
  sqliteTypeFor,
} from './dialect.js'
export type { PhysicalRow, PhysicalValue, SqliteDriver } from './driver.js'
export { toPhysical } from './driver.js'
export { mapSqliteError } from './errors.js'
export { introspectSqlite } from './introspect.js'
