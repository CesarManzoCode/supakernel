import {
  assertNever,
  type Expr,
  type Json,
  type PortableType,
  type SqlValue,
} from '@supakernel/contracts'

export interface CompiledPredicate {
  /** A boolean SQL fragment using `?` placeholders, safe to splice into a `WHERE` clause. */
  readonly sql: string
  readonly params: readonly SqlValue[]
}

export type ColumnTypeLookup = (name: string) => PortableType | undefined

const NUMERIC_TYPES = new Set<PortableType>(['int64', 'decimal'])

function q(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error(`unsafe identifier: ${id}`)
  return `"${id}"`
}

/**
 * Compile a **principal-resolved** policy `Expr` (no `claim` / `context` nodes remain) into a
 * parameterized SQLite boolean predicate (contract §13.1). Column references become quoted
 * identifiers validated against the pattern; every literal becomes a bound `?` parameter.
 * The result is spliced into the `SELECT` / `UPDATE` / `DELETE` `WHERE` clause so the database
 * filters — SupaKernel never fetches all rows and filters in application code.
 *
 * `columnType` supplies the portable type of each column so that ordered comparisons on the
 * canonical decimal-string encoding of `int64` / `decimal` are done numerically.
 */
export function compileSqlitePredicate(
  expr: Expr,
  columnType: ColumnTypeLookup,
): CompiledPredicate {
  const params: SqlValue[] = []
  const sql = emit(expr, columnType, params)
  return { sql, params }
}

/** A standalone check: `SELECT (<predicate>) AS ok` — used for INSERT / UPDATE `WITH CHECK`. */
export function compileSqliteCheck(expr: Expr, columnType: ColumnTypeLookup): CompiledPredicate {
  const inner = compileSqlitePredicate(expr, columnType)
  return { sql: `SELECT (${inner.sql}) AS ok`, params: inner.params }
}

function emit(expr: Expr, ct: ColumnTypeLookup, params: SqlValue[], numeric = false): string {
  switch (expr.kind) {
    case 'literal':
      return bind(expr.value, params)
    case 'column': {
      const base = q(expr.name)
      return numeric || NUMERIC_TYPES.has(ct(expr.name) ?? 'text')
        ? `CAST(${base} AS NUMERIC)`
        : base
    }
    case 'claim':
    case 'context':
      // resolvePrincipalRefs must run first; a surviving node is a programming error.
      throw new Error(`unresolved ${expr.kind} node in policy predicate`)
    case 'not':
      return `(NOT ${emit(expr.term, ct, params)})`
    case 'logic':
      return `(${expr.terms
        .map((t) => emit(t, ct, params))
        .join(expr.op === 'and' ? ' AND ' : ' OR ')})`
    case 'compare':
      return compare(expr, ct, params)
    default:
      return assertNever(expr)
  }
}

function compare(
  expr: Expr & { kind: 'compare' },
  ct: ColumnTypeLookup,
  params: SqlValue[],
): string {
  const ordered = expr.op === 'gt' || expr.op === 'gte' || expr.op === 'lt' || expr.op === 'lte'
  const numericSide = ordered && isNumericColumn(expr, ct)
  const l = emit(expr.left, ct, params, numericSide)
  if (expr.op === 'is') {
    // `x is null`; `x is not null` arrives wrapped in `not`.
    if (expr.right.kind === 'literal' && expr.right.value === null) return `(${l} IS NULL)`
    return `(${l} IS ${emit(expr.right, ct, params)})`
  }
  if (expr.op === 'in') {
    if (expr.right.kind !== 'literal' || !Array.isArray(expr.right.value)) {
      throw new Error('IN needs a literal array')
    }
    const list = expr.right.value.map((v) => bind(v as Json, params)).join(', ')
    return `(${l} IN (${list}))`
  }
  const r = emit(expr.right, ct, params, numericSide)
  switch (expr.op) {
    case 'eq':
      return `(${l} = ${r})`
    case 'neq':
      return `(${l} <> ${r})`
    case 'gt':
      return `(${l} > ${r})`
    case 'gte':
      return `(${l} >= ${r})`
    case 'lt':
      return `(${l} < ${r})`
    case 'lte':
      return `(${l} <= ${r})`
    case 'like':
      return `(${l} LIKE ${r})`
    case 'ilike':
      return `(lower(${l}) LIKE lower(${r}))`
    default:
      return assertNever(expr.op)
  }
}

function isNumericColumn(expr: Expr & { kind: 'compare' }, ct: ColumnTypeLookup): boolean {
  for (const side of [expr.left, expr.right]) {
    if (side.kind === 'column' && NUMERIC_TYPES.has(ct(side.name) ?? 'text')) return true
  }
  return false
}

function bind(value: Json, params: SqlValue[]): string {
  if (value === null) {
    params.push(null)
    return '?'
  }
  if (Array.isArray(value)) throw new Error('array literal is only valid on the right of IN')
  if (typeof value === 'object') throw new Error('object literal is not comparable')
  params.push(value)
  return '?'
}
