import type { Json } from './json.ts'

/**
 * The portable expression grammar (contract §8). This is the ONLY expression language the
 * kernel understands: policy `USING` / `CHECK`, portable `CHECK` constraints and partial-index
 * predicates all compile from `Expr`. Anything outside this grammar is a stable refusal, never
 * a silent approximation.
 *
 * An expression may read: a row column, a verified claim, the request context
 * (subject / tenant / role / now) and literals. It may not read request input, mutable user
 * metadata or perform subqueries.
 */
export type Expr =
  | { readonly kind: 'literal'; readonly value: Json }
  | { readonly kind: 'column'; readonly table: string; readonly name: string }
  | { readonly kind: 'claim'; readonly path: readonly string[] }
  | { readonly kind: 'context'; readonly name: ContextName }
  | {
      readonly kind: 'compare'
      readonly op: CompareOp
      readonly left: Expr
      readonly right: Expr
    }
  | { readonly kind: 'logic'; readonly op: 'and' | 'or'; readonly terms: readonly Expr[] }
  | { readonly kind: 'not'; readonly term: Expr }

export type ContextName = 'subjectId' | 'tenantId' | 'role' | 'now'

export type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is'

export const CONTEXT_NAMES: readonly ContextName[] = ['subjectId', 'tenantId', 'role', 'now']
export const COMPARE_OPS: readonly CompareOp[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'in',
  'is',
]

export const EXPR_KINDS = [
  'literal',
  'column',
  'claim',
  'context',
  'compare',
  'logic',
  'not',
] as const
export type ExprKind = (typeof EXPR_KINDS)[number]

/** Maximum nesting depth accepted by the kernel (contract §10 default limits). */
export const MAX_EXPR_DEPTH = 12

export function exprDepth(expr: Expr): number {
  switch (expr.kind) {
    case 'literal':
    case 'column':
    case 'claim':
    case 'context':
      return 1
    case 'not':
      return 1 + exprDepth(expr.term)
    case 'compare':
      return 1 + Math.max(exprDepth(expr.left), exprDepth(expr.right))
    case 'logic':
      return 1 + Math.max(0, ...expr.terms.map(exprDepth))
    default:
      return assertNever(expr)
  }
}

/** Collects every `{table}` referenced by `column` nodes. */
export function referencedTables(expr: Expr, into: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'column':
      into.add(expr.table)
      return into
    case 'literal':
    case 'claim':
    case 'context':
      return into
    case 'not':
      return referencedTables(expr.term, into)
    case 'compare':
      referencedTables(expr.left, into)
      return referencedTables(expr.right, into)
    case 'logic':
      for (const t of expr.terms) referencedTables(t, into)
      return into
    default:
      return assertNever(expr)
  }
}

/** Exhaustiveness guard: a `never` argument makes a missing `case` a compile error. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`)
}
