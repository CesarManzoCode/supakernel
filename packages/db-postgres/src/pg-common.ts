// The PostgreSQL-family building blocks that carry no driver dependency: introspection,
// the bounded CHECK parser and the SQLSTATE error map. `db-pglite` reuses these so PGlite is
// genuinely "treated as PostgreSQL" (contract §1) without pulling in postgres.js.

export { parsePgCheck, UnsupportedPgCheckError } from './check-parser.js'
export { mapPostgresError } from './errors.js'
export { introspectPostgres, type PgQuery } from './introspect.js'
