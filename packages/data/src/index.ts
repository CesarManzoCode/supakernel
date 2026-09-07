// SupaKernel Data — PostgREST-compatible subset (contract §11, §30 L5).
// Imports contracts / ports / schema / policy only — never Hono or an adapter package.

export { buildStatement, type StatementSpec } from './compile/statement.js'
export {
  checkViolationError,
  type PostgrestErrorBody,
  policyDeniedError,
  toKernelError,
  toPostgrestBody,
} from './error-map.js'
export {
  cardinality,
  DataError,
  dataError,
  dataUnsupported,
  filterRequired,
  malformedFilter,
  unknownRelation,
} from './errors.js'
export { type ExecOutcome, executeData } from './execute.js'
export { createDataHandler, type DataHandlerDeps } from './handler.js'
export { generateOpenApi } from './openapi.js'
export { type ColumnLookup, coerce, parseFilters } from './parse-filter.js'
export { type Preferences, parsePrefer } from './parse-prefer.js'
export { parseSelect } from './parse-select.js'
export { type ParsedRequest, parseRequest, type RawRequest } from './parse-url.js'
export {
  type DataContext,
  type DataQueryPlan,
  type EmbedNode,
  type ProjectedColumn,
  planData,
} from './plan.js'
export { type DataHttpResponse, shapeResult } from './result.js'
