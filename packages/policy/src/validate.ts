import {
  assertNever,
  type Expr,
  findColumn,
  findTable,
  POLICY_ACTIONS,
  type PolicyRule,
  referencedTables,
  type SchemaIR,
  type Table,
} from '@supakernel/contracts'
import { actionUsesCheck, actionUsesUsing } from './combine.js'
import { policyInvalid } from './errors.js'
import { assertExprShape, PolicyValidationError } from './expr-sql.js'

export interface PolicyProblem {
  readonly ruleId: string
  readonly detail: string
}

/**
 * Validate a policy rule set against the schema (contract §13.1). Every rule is checked in
 * `deploy`, before it can govern a request:
 *
 * - the table and every referenced column exist;
 * - `USING` is present only for actions it governs, `CHECK` likewise;
 * - an expression references only *this* table's columns, verified claims, context and literals
 *   (the `Expr` grammar cannot express request input, so that class is structurally excluded);
 * - expression depth is within the kernel limit;
 * - `immutable` fields are real columns.
 */
export function validatePolicies(schema: SchemaIR, rules: readonly PolicyRule[]): PolicyProblem[] {
  const problems: PolicyProblem[] = []
  const add = (ruleId: string, detail: string): void => {
    problems.push({ ruleId, detail })
  }

  for (const rule of rules) {
    if (!(POLICY_ACTIONS as readonly string[]).includes(rule.action)) {
      add(rule.id, `unknown action "${rule.action}"`)
      continue
    }
    if (rule.mode !== 'permissive' && rule.mode !== 'restrictive') {
      add(rule.id, `unknown mode "${rule.mode}"`)
    }
    if (typeof rule.role !== 'string' || rule.role.length === 0) {
      add(rule.id, 'role must be a non-empty string or "*"')
    }

    const isStorage = rule.action === 'storage.read' || rule.action === 'storage.write'
    const table = findTable(schema, rule.table)
    if (!table && !isStorage) {
      add(rule.id, `unknown table "${rule.table}"`)
      continue
    }

    if (rule.using !== null) {
      if (!actionUsesUsing(rule.action)) {
        add(rule.id, `action "${rule.action}" has no USING clause`)
      }
      checkExpr(add, rule.id, rule.using, table, `${rule.id}.using`)
    }
    if (rule.check !== null) {
      if (!actionUsesCheck(rule.action)) {
        add(rule.id, `action "${rule.action}" has no CHECK clause`)
      }
      checkExpr(add, rule.id, rule.check, table, `${rule.id}.check`)
    }

    if (table) {
      for (const [label, spec] of [
        ['read', rule.fields.read],
        ['write', rule.fields.write],
        ['immutable', rule.fields.immutable],
      ] as const) {
        if (spec === '*') continue
        for (const f of spec) {
          if (!findColumn(table, f)) add(rule.id, `${label} field "${f}" is not a column`)
        }
      }
    }
  }

  return problems
}

/** Throw `PolicyValidationError` on the first problem (used at deploy time). */
export function assertPoliciesValid(schema: SchemaIR, rules: readonly PolicyRule[]): void {
  const [first] = validatePolicies(schema, rules)
  if (first) {
    throw new PolicyValidationError(policyInvalid(`${first.ruleId}: ${first.detail}`))
  }
}

function checkExpr(
  add: (ruleId: string, detail: string) => void,
  ruleId: string,
  expr: Expr,
  table: Table | undefined,
  where: string,
): void {
  try {
    assertExprShape(expr, where)
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      add(ruleId, err.kernelError.message)
      return
    }
    throw err
  }
  const refs = referencedTables(expr)
  for (const t of refs) {
    if (table && t !== table.name) {
      add(ruleId, `expression references another table "${t}" (subqueries are not allowed)`)
    }
  }
  if (table) {
    for (const col of columnNames(expr)) {
      if (!findColumn(table, col)) add(ruleId, `expression references unknown column "${col}"`)
    }
  }
}

function columnNames(expr: Expr, into: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'column':
      into.add(expr.name)
      return into
    case 'literal':
    case 'claim':
    case 'context':
      return into
    case 'not':
      return columnNames(expr.term, into)
    case 'compare':
      columnNames(expr.left, into)
      return columnNames(expr.right, into)
    case 'logic':
      for (const t of expr.terms) columnNames(t, into)
      return into
    default:
      return assertNever(expr)
  }
}
