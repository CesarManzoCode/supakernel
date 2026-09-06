// SupaKernel canonical contracts. Dependency-free except the JSON-boundary validator (zod).
// See docs/SupaKernel-Contract.md §8.

export type {
  CapabilityManifest,
  DatabaseCapabilities,
  IsolationLevel as CapabilityIsolationLevel,
  RuntimeLimits,
} from './capabilities.ts'
export { DEFAULT_RUNTIME_LIMITS } from './capabilities.ts'
export type { KernelError, KernelErrorCategory, KernelErrorInit } from './error.ts'
export {
  KERNEL_ERROR_CATEGORIES,
  KernelErrorException,
  kernelError,
  looksLikeLeak,
  redactError,
} from './error.ts'
export type { CompareOp, ContextName, Expr, ExprKind } from './expr.ts'
export {
  assertNever,
  COMPARE_OPS,
  CONTEXT_NAMES,
  EXPR_KINDS,
  exprDepth,
  MAX_EXPR_DEPTH,
  referencedTables,
} from './expr.ts'
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
} from './identifiers.ts'
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
} from './identifiers.ts'
export type { Json, JsonArray, JsonObject } from './json.ts'
export { canonicalJson, isJsonArray, isJsonObject, jsonEquals } from './json.ts'
export type { ObservedSchema, UnmodeledObject } from './observed-schema.ts'
export type { ParseResult } from './parse.ts'
export {
  EXPR_KIND_SET,
  jsonSchema,
  parse,
  projectSchemaSchema,
  queryOperationSchema,
} from './parse.ts'
export type { PolicyAction, PolicyFieldSpec, PolicyRule, SecurityPlan } from './policy.ts'
export { isDeny, POLICY_ACTIONS } from './policy.ts'
export type { Principal } from './principal.ts'
export { anonymousPrincipal, isPrivilegedService } from './principal.ts'
export type { Order, Page, QueryKind, QueryOperation, Selection } from './query.ts'
export { operationTable, QUERY_KINDS, requiresFilter } from './query.ts'
export type { IpClass, RequestContext } from './request.ts'
export type {
  ComparatorMode,
  ComparisonSpec,
  NormalizerId,
  ObservationSpec,
  ScenarioSpec,
  ScenarioStep,
} from './scenario.ts'
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
} from './schema.ts'
export { findColumn, findTable, isPortableType, PORTABLE_TYPES } from './schema.ts'
export type {
  DbResult,
  DbRow,
  IsolationLevel,
  SqlStatement,
  SqlValue,
  Transaction,
  TransactionOptions,
} from './sql.ts'
export { sql } from './sql.ts'
