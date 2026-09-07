import type { Json, SecurityPlan } from '@supakernel/contracts'
import type { ColumnTypeLookup, CompiledPredicate } from './compile/sqlite-predicate.js'
import { compileSqlitePredicate } from './compile/sqlite-predicate.js'
import { evalCheck } from './expr-sql.js'

/**
 * The compiled `USING` predicate for the SQLite family (contract §13.1). The data / storage /
 * realtime layers `AND` this into every `SELECT` / `UPDATE` / `DELETE` `WHERE` clause so the
 * database filters — SupaKernel never fetches all rows and filters in application code.
 * Returns `null` when the action has no row filter (e.g. `insert`) or the plan is a bypass.
 */
export function policyUsingPredicate(
  plan: SecurityPlan,
  columnType: ColumnTypeLookup,
): CompiledPredicate | null {
  if (plan.rowUsing === null) return null
  return compileSqlitePredicate(plan.rowUsing, columnType)
}

/** The compiled `WITH CHECK` predicate, for pushing into an `UPDATE … WHERE` post-image test. */
export function policyCheckPredicate(
  plan: SecurityPlan,
  columnType: ColumnTypeLookup,
): CompiledPredicate | null {
  if (plan.rowCheck === null) return null
  return compileSqlitePredicate(plan.rowCheck, columnType)
}

/**
 * Evaluate the plan's `WITH CHECK` against a fully-formed candidate row, in the same
 * transaction as the write (contract §13.1). Used for `INSERT` and the post-image of `UPDATE`
 * / `upsert` in the SQLite family. `true` means the row is permitted.
 */
export function checkRowAllowed(
  plan: SecurityPlan,
  row: Readonly<Record<string, Json>>,
  now: string,
): boolean {
  if (plan.decision === 'deny') return false
  if (plan.rowCheck === null) return true
  return evalCheck(plan.rowCheck, row, now)
}
