import type { Expr, Json, Order, SqlStatement, SqlValue } from '@supakernel/contracts'
import { dataError, malformedFilter } from '../errors.js'
import { type ColumnType, compilePredicate, type Dialect } from './predicate.js'

function q(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id))
    throw dataError(malformedFilter(`unsafe identifier "${id}"`))
  return `"${id}"`
}

function ph(dialect: Dialect, n: number): string {
  return dialect === 'postgres' ? `$${n}` : '?'
}

function scalar(v: Json): SqlValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string')
    return v
  // json / object / array column value — serialize to canonical text
  return JSON.stringify(v)
}

export interface SelectSpec {
  readonly kind: 'select'
  readonly table: string
  /** Projected columns; empty ⇒ `count(*)` only. */
  readonly columns: readonly string[]
  readonly where: Expr | null
  readonly order: readonly Order[]
  readonly limit: number | null
  readonly offset: number | null
  readonly countOnly?: boolean
  readonly columnType: ColumnType
}

export interface InsertSpec {
  readonly kind: 'insert'
  readonly table: string
  readonly columns: readonly string[]
  readonly rows: readonly Readonly<Record<string, Json>>[]
  readonly missing: 'null' | 'default'
  readonly onConflict: readonly string[]
  readonly resolution: 'error' | 'merge' | 'ignore'
  /** `null` ⇒ no `RETURNING`. */
  readonly returning: readonly string[] | null
  readonly columnType: ColumnType
}

export interface UpdateSpec {
  readonly kind: 'update'
  readonly table: string
  readonly patch: Readonly<Record<string, Json>>
  readonly where: Expr
  readonly returning: readonly string[] | null
  readonly columnType: ColumnType
}

export interface DeleteSpec {
  readonly kind: 'delete'
  readonly table: string
  readonly where: Expr
  readonly returning: readonly string[] | null
  readonly columnType: ColumnType
}

export type StatementSpec = SelectSpec | InsertSpec | UpdateSpec | DeleteSpec

export function buildStatement(spec: StatementSpec, dialect: Dialect): SqlStatement {
  switch (spec.kind) {
    case 'select':
      return buildSelect(spec, dialect)
    case 'insert':
      return buildInsert(spec, dialect)
    case 'update':
      return buildUpdate(spec, dialect)
    case 'delete':
      return buildDelete(spec, dialect)
  }
}

function projection(columns: readonly string[]): string {
  return columns.length === 0 ? 'count(*) AS "sk_count"' : columns.map(q).join(', ')
}

function orderClause(order: readonly Order[]): string {
  if (order.length === 0) return ''
  const parts = order.map(
    (o) =>
      `${q(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'} NULLS ${o.nulls === 'first' ? 'FIRST' : 'LAST'}`,
  )
  return ` ORDER BY ${parts.join(', ')}`
}

function buildSelect(spec: SelectSpec, dialect: Dialect): SqlStatement {
  const params: SqlValue[] = []
  let text = spec.countOnly
    ? `SELECT count(*) AS "sk_count" FROM ${q(spec.table)}`
    : `SELECT ${projection(spec.columns)} FROM ${q(spec.table)}`
  if (spec.where) {
    const frag = compilePredicate(spec.where, spec.columnType, dialect, params.length)
    params.push(...frag.params)
    text += ` WHERE ${frag.text}`
  }
  if (!spec.countOnly) {
    text += orderClause(spec.order)
    if (spec.limit !== null && spec.limit !== Number.MAX_SAFE_INTEGER) {
      text += ` LIMIT ${Math.max(0, Math.floor(spec.limit))}`
    }
    if (spec.offset) text += ` OFFSET ${Math.max(0, Math.floor(spec.offset))}`
  }
  return { text, parameters: params }
}

function returningClause(returning: readonly string[] | null): string {
  if (returning === null) return ''
  if (returning.length === 0) return ' RETURNING *'
  return ` RETURNING ${returning.map(q).join(', ')}`
}

function buildInsert(spec: InsertSpec, dialect: Dialect): SqlStatement {
  const cols = spec.columns
  if (cols.length === 0) throw dataError(malformedFilter('insert has no columns'))
  const params: SqlValue[] = []
  const tuples = spec.rows.map((row) => {
    const cells = cols.map((c) => {
      if (c in row) {
        params.push(scalar(row[c] as Json))
        return ph(dialect, params.length)
      }
      return spec.missing === 'default' ? 'DEFAULT' : 'NULL'
    })
    return `(${cells.join(', ')})`
  })

  let text = `INSERT INTO ${q(spec.table)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}`

  if (spec.resolution === 'ignore') {
    text +=
      spec.onConflict.length > 0
        ? ` ON CONFLICT (${spec.onConflict.map(q).join(', ')}) DO NOTHING`
        : ' ON CONFLICT DO NOTHING'
  } else if (spec.resolution === 'merge') {
    if (spec.onConflict.length === 0) {
      throw dataError(malformedFilter('upsert requires on_conflict to name the target'))
    }
    const updates = cols
      .filter((c) => !spec.onConflict.includes(c))
      .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
    text += ` ON CONFLICT (${spec.onConflict.map(q).join(', ')}) DO ${
      updates.length > 0 ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'
    }`
  }

  text += returningClause(spec.returning)
  return { text, parameters: params }
}

function buildUpdate(spec: UpdateSpec, dialect: Dialect): SqlStatement {
  const keys = Object.keys(spec.patch)
  if (keys.length === 0) throw dataError(malformedFilter('update payload is empty'))
  const params: SqlValue[] = []
  const sets = keys.map((k) => {
    params.push(scalar(spec.patch[k] as Json))
    return `${q(k)} = ${ph(dialect, params.length)}`
  })
  let text = `UPDATE ${q(spec.table)} SET ${sets.join(', ')}`
  const frag = compilePredicate(spec.where, spec.columnType, dialect, params.length)
  params.push(...frag.params)
  text += ` WHERE ${frag.text}${returningClause(spec.returning)}`
  return { text, parameters: params }
}

function buildDelete(spec: DeleteSpec, dialect: Dialect): SqlStatement {
  const params: SqlValue[] = []
  const frag = compilePredicate(spec.where, spec.columnType, dialect, 0)
  params.push(...frag.params)
  return {
    text: `DELETE FROM ${q(spec.table)} WHERE ${frag.text}${returningClause(spec.returning)}`,
    parameters: params,
  }
}
