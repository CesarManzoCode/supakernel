import { findTable, type PolicyRule, type SchemaIR } from '@supakernel/contracts'
import { policyInvalid } from './errors.js'
import { PolicyValidationError } from './expr-sql.js'

/** The declared columns of a table, in schema order. */
export function tableColumns(schema: SchemaIR, table: string): readonly string[] {
  const t = findTable(schema, table)
  if (!t) throw new PolicyValidationError(policyInvalid(`unknown table "${table}"`))
  return t.columns.map((c) => c.name)
}

/** Expand a `'*'` / explicit field list against the real columns (contract §13.1). */
export function expandFields(spec: readonly string[] | '*', columns: readonly string[]): string[] {
  if (spec === '*') return [...columns]
  return spec.filter((f) => columns.includes(f))
}

/** A rule with its `'*'` field specs expanded against the schema. */
export interface ExpandedRule {
  readonly rule: PolicyRule
  readonly read: ReadonlySet<string>
  readonly write: ReadonlySet<string>
  readonly immutable: ReadonlySet<string>
}

export function expandRule(rule: PolicyRule, columns: readonly string[]): ExpandedRule {
  return {
    rule,
    read: new Set(expandFields(rule.fields.read, columns)),
    write: new Set(expandFields(rule.fields.write, columns)),
    immutable: new Set(expandFields(rule.fields.immutable, columns)),
  }
}
