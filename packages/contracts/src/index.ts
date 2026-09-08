// SupaKernel canonical contracts. Dependency-free except the JSON-boundary validator (zod).
// See docs/SupaKernel-Contract.md §8.

export {
  base64ToBytes,
  base64ToUtf8,
  bytesToBase64,
  bytesToBase64Url,
} from './bytes.js'
export type {
  CapabilityManifest,
  DatabaseCapabilities,
  IsolationLevel as CapabilityIsolationLevel,
  RuntimeLimits,
} from './capabilities.js'
export { DEFAULT_RUNTIME_LIMITS } from './capabilities.js'
export type { KernelError, KernelErrorCategory, KernelErrorInit } from './error.js'
export {
  KERNEL_ERROR_CATEGORIES,
  KernelErrorException,
  kernelError,
  looksLikeLeak,
  redactError,
} from './error.js'
export type { CompareOp, ContextName, Expr, ExprKind } from './expr.js'
export {
  assertNever,
  COMPARE_OPS,
  CONTEXT_NAMES,
  EXPR_KINDS,
  exprDepth,
  MAX_EXPR_DEPTH,
  referencedTables,
} from './expr.js'
export { sha256Hex, sha256HexBytes } from './hash.js'
export type {
  Brand,
  Family,
  Fingerprint,
  OperationId,
  PolicyId,
  ProjectRef,
  RequestId,
  RuntimeId,
  ScenarioId,
  SchemaHash,
  Seed,
  SessionId,
  SubjectId,
  TenantId,
} from './identifiers.js'
export {
  asFingerprint,
  asOperationId,
  asPolicyId,
  asProjectRef,
  asRequestId,
  asScenarioId,
  asSchemaHash,
  asSeed,
  asSessionId,
  asSubjectId,
  asTenantId,
  FAMILIES,
  RUNTIME_IDS,
} from './identifiers.js'
export type { Json, JsonArray, JsonObject } from './json.js'
export { canonicalJson, isJsonArray, isJsonObject, jsonEquals } from './json.js'
export type { ObservedSchema, UnmodeledObject } from './observed-schema.js'
export type { ParseResult } from './parse.js'
export {
  EXPR_KIND_SET,
  jsonSchema,
  parse,
  projectSchemaSchema,
  queryOperationSchema,
} from './parse.js'
export type { PolicyAction, PolicyFieldSpec, PolicyRule, SecurityPlan } from './policy.js'
export { isDeny, POLICY_ACTIONS } from './policy.js'
export type { Principal } from './principal.js'
export { anonymousPrincipal, isPrivilegedService } from './principal.js'
export type { Order, Page, QueryKind, QueryOperation, Selection } from './query.js'
export { operationTable, QUERY_KINDS, requiresFilter } from './query.js'
export type { IpClass, RequestContext } from './request.js'
export type {
  ComparatorMode,
  ComparisonSpec,
  NormalizerId,
  ObservationSpec,
  ScenarioSpec,
  ScenarioStep,
} from './scenario.js'
export type {
  CheckConstraint,
  Column,
  ColumnDefault,
  ForeignKey,
  ForeignKeyAction,
  Index,
  PortableType,
  ProjectSchema,
  SchemaIR,
  Sequence,
  Table,
  UniqueConstraint,
} from './schema.js'
export { findColumn, findTable, isPortableType, PORTABLE_TYPES } from './schema.js'
export type {
  DbResult,
  DbRow,
  IsolationLevel,
  SqlStatement,
  SqlValue,
  Transaction,
  TransactionOptions,
} from './sql.js'
export { sql } from './sql.js'
