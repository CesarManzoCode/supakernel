// SupaKernel policy compiler / security kernel. One PolicyIR, native PG RLS + safe SQLite
// predicate rewrite, field-level security. See docs/SupaKernel-Contract.md §13, §30 L4.
// Imports only @supakernel/contracts and @supakernel/ports (never @supakernel/schema — §6.2).

export {
  actionUsesCheck,
  actionUsesUsing,
  type CombinedPolicy,
  combine,
  ruleApplies,
} from './combine.js'
export {
  bootstrapStatements,
  compilePostgresRls,
  exprToPgPolicy,
  principalGucs,
  SK_ROLES,
} from './compile/postgres-rls.js'
export {
  type ColumnTypeLookup,
  type CompiledPredicate,
  compileSqliteCheck,
  compileSqlitePredicate,
} from './compile/sqlite-predicate.js'
export { checkViolation, fieldForbidden, policyDenied, policyInvalid } from './errors.js'
export {
  assertExprShape,
  claimValue,
  contextValue,
  evalCheck,
  PolicyValidationError,
  resolvePrincipalRefs,
} from './expr-sql.js'
export { computeFieldMask, type FieldMask } from './field-mask.js'
export { fingerprint } from './fingerprint.js'
export { buildSecurityPlan, type PlanRequest, type PolicyContext } from './plan.js'
export { checkRowAllowed, policyCheckPredicate, policyUsingPredicate } from './rewrite.js'
export { assertPoliciesValid, type PolicyProblem, validatePolicies } from './validate.js'
export { type ExpandedRule, expandFields, expandRule, tableColumns } from './wildcard.js'
