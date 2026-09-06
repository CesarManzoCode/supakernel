// SupaKernel schema / migration engine. See docs/SupaKernel-Contract.md §17, §30 L3.
// libpg-query is used only here (Node, build-time); the runtime receives IR.

export {
  type ApplyOptions,
  type ApplyResult,
  applyMigration,
  detectDrift,
} from './apply.js'
export { astToExpr, UnsupportedExprError } from './ast-expr.js'
export {
  createIndexStatement as createPostgresIndex,
  createSequenceStatements as createPostgresSequence,
  createTableStatement as createPostgresTable,
  exprToPg,
  PG_TYPE,
} from './dialects/postgres.js'
export {
  createIndexStatement as createSqliteIndex,
  createTableStatement as createSqliteTable,
  exprToSqlite,
  SQLITE_TYPE,
} from './dialects/sqlite.js'
export { diffSchemas, type SchemaChange, type SchemaDiff } from './diff.js'
export { canonicalSchemaJson, hashSchema } from './hash.js'
export { observePostgres } from './introspection/postgres.js'
export { observeSqlite } from './introspection/sqlite.js'
export {
  acquireLease,
  currentSchemaHash,
  ensureJournal,
  JOURNAL_DDL,
  releaseLease,
  type StepState,
} from './journal.js'
export { normalizeExpr, normalizeSchema } from './normalize.js'
export { parsePgSchema, schemaCapabilityError, UnsupportedSchemaError } from './parse-pg.js'
export {
  destructiveRefusalError,
  MIGRATION_PHASES,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationStep,
  type PlanOptions,
  planMigration,
  type RenameMapping,
} from './plan.js'
export { type SchemaProblem, validateSchema } from './validate.js'
