import type { Expr } from './expr.ts'

export type PolicyAction =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'subscribe'
  | 'storage.read'
  | 'storage.write'

export const POLICY_ACTIONS: readonly PolicyAction[] = [
  'select',
  'insert',
  'update',
  'delete',
  'subscribe',
  'storage.read',
  'storage.write',
]

export interface PolicyFieldSpec {
  readonly read: readonly string[] | '*'
  readonly write: readonly string[] | '*'
  readonly immutable: readonly string[]
}

/** One row/field authorization rule (contract §8, §13). */
export interface PolicyRule {
  readonly id: string
  readonly table: string
  readonly action: PolicyAction
  readonly role: string | '*'
  readonly mode: 'permissive' | 'restrictive'
  readonly using: Expr | null
  readonly check: Expr | null
  readonly fields: PolicyFieldSpec
}

/**
 * The compiled authorization decision for one operation (contract §8, §13.1). `fingerprint`
 * is a stable hash of the effective rule set — it is safe to log; the underlying claims are not.
 */
export interface SecurityPlan {
  readonly decision: 'allow' | 'deny'
  readonly rowUsing: Expr | null
  readonly rowCheck: Expr | null
  readonly readableFields: ReadonlySet<string>
  readonly writableFields: ReadonlySet<string>
  readonly fingerprint: string
}

export function isDeny(plan: SecurityPlan): boolean {
  return plan.decision === 'deny'
}
