// SupaKernel PostgreSQL adapter (postgres.js -> PostgreSQL 18.6). Driver only.
// See docs/SupaKernel-Contract.md §9.
export { openPostgres, PostgresAdapter, type PostgresAdapterOptions } from './adapter.js'
export { parsePgCheck, UnsupportedPgCheckError } from './check-parser.js'
export { mapPostgresError } from './errors.js'
export { introspectPostgres, type PgQuery } from './introspect.js'
