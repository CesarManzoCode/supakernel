import {
  assertNever,
  type Expr,
  type Json,
  type PortableType,
  type SqlValue,
} from '@supakernel/contracts'
import { dataError, malformedFilter } from '../errors.js'

export type ColumnType = (name: string) => PortableType | undefined
export type Dialect = 'postgres' | 'sqlite'

const NUMERIC = new Set<PortableType>(['int64', 'decimal'])

export interface Frag {
  readonly text: string
  readonly params: readonly SqlValue[]
}

function q(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id))
    throw dataError(malformedFilter(`unsafe identifier "${id}"`))
  return `"${id}"`
}

/**
 * Compile a **literal-only** `Expr` (filters + resolved policy predicates) to a parameterized
 * boolean SQL fragment (contract §9.2 — every value is bound, only `SchemaIR` identifiers are
 * interpolated). `place` produces the dialect placeholder for the n-th parameter.
 */
export function compilePredicate(
  expr: Expr,
  columnType: ColumnType,
  dialect: Dialect,
  startIndex = 0,
): Frag {
  const params: SqlValue[] = []
  const push = (v: SqlValue): string => {
    params.push(v)
    return dialect === 'postgres' ? `$${startIndex + params.length}` : '?'
  }
  const text = emit(expr, columnType, dialect, push, false)
  return { text, params }
}

function colRef(
  name: string,
  type: PortableType | undefined,
  dialect: Dialect,
  numeric: boolean,
): string {
  const base = `${q(name)}`
  if (!numeric && !NUMERIC.has(type ?? 'text')) return base
  return dialect === 'postgres' ? `(${base})::numeric` : `CAST(${base} AS NUMERIC)`
}

function emit(
  expr: Expr,
  ct: ColumnType,
  dialect: Dialect,
  push: (v: SqlValue) => string,
  numeric: boolean,
): string {
  switch (expr.kind) {
    case 'literal':
      return bind(expr.value, push)
    case 'column':
      return colRef(expr.name, ct(expr.name), dialect, numeric)
    case 'claim':
    case 'context':
      throw new Error(`unresolved ${expr.kind} node in a data predicate`)
    case 'not':
      return `(NOT ${emit(expr.term, ct, dialect, push, numeric)})`
    case 'logic':
      return `(${expr.terms
        .map((t) => emit(t, ct, dialect, push, false))
        .join(expr.op === 'and' ? ' AND ' : ' OR ')})`
    case 'compare':
      return compare(expr, ct, dialect, push)
    default:
      return assertNever(expr)
  }
}

function compare(
  expr: Expr & { kind: 'compare' },
  ct: ColumnType,
  dialect: Dialect,
  push: (v: SqlValue) => string,
): string {
  const ordered = expr.op === 'gt' || expr.op === 'gte' || expr.op === 'lt' || expr.op === 'lte'
  const numeric =
    ordered &&
    [expr.left, expr.right].some((e) => e.kind === 'column' && NUMERIC.has(ct(e.name) ?? 'text'))
  const l = emit(expr.left, ct, dialect, push, numeric)

  if (expr.op === 'is') {
    if (expr.right.kind === 'literal' && expr.right.value === null) return `(${l} IS NULL)`
    return `(${l} IS ${emit(expr.right, ct, dialect, push, false)})`
  }
  if (expr.op === 'in') {
    if (expr.right.kind !== 'literal' || !Array.isArray(expr.right.value)) {
      throw dataError(malformedFilter('IN needs a literal list'))
    }
    if (expr.right.value.length === 0) return '(1 = 0)'
    return `(${l} IN (${expr.right.value.map((v) => bind(v as Json, push)).join(', ')}))`
  }
  const r = emit(expr.right, ct, dialect, push, numeric)
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
      return dialect === 'postgres' ? `(${l} ILIKE ${r})` : `(lower(${l}) LIKE lower(${r}))`
    default:
      return assertNever(expr.op)
  }
}

function bind(value: Json, push: (v: SqlValue) => string): string {
  if (value === null) return push(null)
  if (Array.isArray(value))
    throw dataError(malformedFilter('array literal only valid on the right of IN'))
  if (typeof value === 'object')
    throw dataError(malformedFilter('object literal is not comparable'))
  return push(value)
}
