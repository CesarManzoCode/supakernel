// SupaKernel PostgreSQL adapter (postgres.js -> PostgreSQL 18.6). Driver only.
// See docs/SupaKernel-Contract.md §9.
export { openPostgres, PostgresAdapter, type PostgresAdapterOptions } from './adapter.ts'
export { parsePgCheck, UnsupportedPgCheckError } from './check-parser.ts'
export { mapPostgresError } from './errors.ts'
export { introspectPostgres, type PgQuery } from './introspect.ts'
