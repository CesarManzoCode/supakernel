import type { Expr, PolicyAction, PolicyRule, Principal, SchemaIR } from '@supakernel/contracts'
import { type ExpandedRule, expandRule, tableColumns } from './wildcard.js'

const TRUE: Expr = { kind: 'literal', value: true }

/** Whether a rule's `USING` clause governs this action (existing rows) — contract §13.1. */
export function actionUsesUsing(action: PolicyAction): boolean {
  return (
    action === 'select' ||
    action === 'update' ||
    action === 'delete' ||
    action === 'subscribe' ||
    action === 'storage.read' ||
    action === 'storage.write'
  )
}

/** Whether a rule's `CHECK` clause governs this action (new / resulting rows) — contract §13.1. */
export function actionUsesCheck(action: PolicyAction): boolean {
  return action === 'insert' || action === 'update' || action === 'storage.write'
}

/** A rule applies to a request when table, action and role all match (contract §13.1). */
export function ruleApplies(
  rule: PolicyRule,
  table: string,
  action: PolicyAction,
  principal: Principal,
): boolean {
  if (rule.table !== table) return false
  if (rule.action !== action) return false
  return rule.role === '*' || rule.role === principal.role
}

export interface CombinedPolicy {
  /** A table has RLS enabled iff at least one policy rule targets it (contract §13.1). */
  readonly rlsEnabled: boolean
  readonly permissive: readonly ExpandedRule[]
  readonly restrictive: readonly ExpandedRule[]
  readonly columns: readonly string[]
  /** `AND( OR(permissive USING) , restrictive USING… )`, or `null` when the action has no USING. */
  readonly rowUsing: Expr | null
  /** Same shape for CHECK; `null` when the action has no CHECK. */
  readonly rowCheck: Expr | null
}

export function combine(
  schema: SchemaIR,
  rules: readonly PolicyRule[],
  table: string,
  action: PolicyAction,
  principal: Principal,
): CombinedPolicy {
  const columns = tableColumns(schema, table)
  const rlsEnabled = rules.some((r) => r.table === table)
  const applicable = rules.filter((r) => ruleApplies(r, table, action, principal))
  const permissive = applicable
    .filter((r) => r.mode === 'permissive')
    .map((r) => expandRule(r, columns))
  const restrictive = applicable
    .filter((r) => r.mode === 'restrictive')
    .map((r) => expandRule(r, columns))

  return {
    rlsEnabled,
    permissive,
    restrictive,
    columns,
    rowUsing: actionUsesUsing(action) ? combineClause(permissive, restrictive, 'using') : null,
    rowCheck: actionUsesCheck(action) ? combineClause(permissive, restrictive, 'check') : null,
  }
}

function combineClause(
  permissive: readonly ExpandedRule[],
  restrictive: readonly ExpandedRule[],
  clause: 'using' | 'check',
): Expr | null {
  if (permissive.length === 0) {
    // No permissive grant → default deny. A `false` predicate makes the SQL path match no row
    // and the JS check reject every candidate, independent of the decision-level short circuit.
    return { kind: 'literal', value: false }
  }
  const permTerms: Expr[] = permissive.map((p) => p.rule[clause] ?? TRUE)
  const orPart: Expr =
    permTerms.length === 1 ? (permTerms[0] as Expr) : { kind: 'logic', op: 'or', terms: permTerms }

  const restrictTerms: Expr[] = restrictive
    .map((r) => r.rule[clause])
    .filter((e): e is Expr => e !== null)

  if (restrictTerms.length === 0) return orPart
  return { kind: 'logic', op: 'and', terms: [orPart, ...restrictTerms] }
}
