import {
  assertNever,
  type Column,
  type Expr,
  type Index,
  type PortableType,
  type ProjectSchema,
  type Sequence,
  type SqlStatement,
  type Table,
} from '@supakernel/contracts'

/**
 * SQLite DDL emission for the portable `SchemaIR` (contract §17.1, §30 L3). The physical type
 * names deliberately avoid the substring "INT" for TEXT-affinity columns — SQLite assigns
 * INTEGER affinity to any declared type containing "INT", which would silently coerce the
 * canonical decimal string used for `int64` / `decimal` and lose precision at the JS boundary.
 * This table MUST agree with `@supakernel/db-sqlite`'s dialect; a test pins the equivalence.
 */
export const SQLITE_TYPE: Record<PortableType, string> = {
  bool: 'SK_BOOL',
  int32: 'INTEGER',
  int64: 'SK_TEXT_I64',
  float64: 'REAL',
  decimal: 'SK_TEXT_DEC',
  text: 'TEXT',
  uuid: 'SK_TEXT_UUID',
  date: 'SK_TEXT_DATE',
  timestamp: 'SK_TEXT_TS',
  timestamptz: 'SK_TEXT_TSTZ',
  json: 'SK_TEXT_JSON',
  bytes: 'BLOB',
  enum: 'SK_TEXT_ENUM',
}

const DECIMAL_STRING_TYPES = new Set<PortableType>(['int64', 'decimal'])

function q(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error(`unsafe identifier: ${id}`)
  return `"${id}"`
}

function ref(_table: string, column: string, type: PortableType): string {
  const base = q(column)
  return DECIMAL_STRING_TYPES.has(type) ? `CAST(${base} AS NUMERIC)` : base
}

/** Compile an `Expr` to a SQLite boolean predicate. Column types come from the table. */
export function exprToSqlite(expr: Expr, columnType: (name: string) => PortableType): string {
  switch (expr.kind) {
    case 'literal':
      return literal(expr.value)
    case 'column':
      return ref(expr.table, expr.name, columnType(expr.name))
    case 'claim':
      throw new Error('claim references are not valid in a CHECK / index predicate')
    case 'context':
      throw new Error('context references are not valid in a CHECK / index predicate')
    case 'not':
      return `(NOT ${exprToSqlite(expr.term, columnType)})`
    case 'logic':
      return `(${expr.terms.map((t) => exprToSqlite(t, columnType)).join(expr.op === 'and' ? ' AND ' : ' OR ')})`
    case 'compare': {
      const l = exprToSqlite(expr.left, columnType)
      const r = exprToSqlite(expr.right, columnType)
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
        case 'in':
          return `(${l} IN (${inList(expr.right)}))`
        case 'is':
          return `(${l} IS ${r})`
        default:
          throw new Error(`unsupported compare op`)
      }
    }
    default:
      return assertNever(expr)
  }
}

function inList(right: Expr): string {
  if (right.kind !== 'literal' || !Array.isArray(right.value))
    throw new Error('IN needs a literal array')
  return right.value.map((v) => literal(v)).join(', ')
}

function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return `'${value.toString()}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function columnClause(table: Table, col: Column): string {
  const parts = [q(col.name), SQLITE_TYPE[col.type]]
  if (table.primaryKey.length === 1 && table.primaryKey[0] === col.name) parts.push('PRIMARY KEY')
  if (!col.nullable) parts.push('NOT NULL')
  if (col.default) parts.push(`DEFAULT ${defaultClause(col.default)}`)
  return parts.join(' ')
}

function defaultClause(def: NonNullable<Column['default']>): string {
  switch (def.kind) {
    case 'literal':
      return literal(def.value)
    case 'currentTimestamp':
      return "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    case 'uuidV4':
      return "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))))"
    case 'identity':
      return `/* sk:identity:${def.sequence} */ '0'`
    default:
      return assertNever(def)
  }
}

export function createTableStatement(schema: ProjectSchema, table: Table): SqlStatement {
  const columnType = (name: string): PortableType =>
    table.columns.find((c) => c.name === name)?.type ?? 'text'
  const lines: string[] = table.columns.map((c) => columnClause(table, c))

  if (table.primaryKey.length > 1) {
    lines.push(`PRIMARY KEY (${table.primaryKey.map(q).join(', ')})`)
  }
  for (const u of table.uniques) {
    lines.push(`CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(', ')})`)
  }
  for (const fk of table.foreignKeys) {
    lines.push(
      `CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
        `REFERENCES ${q(fk.referencesTable)} (${fk.referencesColumns.map(q).join(', ')}) ` +
        `ON DELETE ${fkAction(fk.onDelete)} ON UPDATE ${fkAction(fk.onUpdate)}`,
    )
  }
  for (const c of table.checks) {
    lines.push(`CONSTRAINT ${q(c.name)} CHECK ${exprToSqlite(c.expr, columnType)}`)
  }
  // SQLite has no enum type: enforce the label set with a CHECK named `<table>_<col>_enum`,
  // which introspection recognises and folds back into `column.enumLabels`.
  for (const col of table.columns) {
    if (col.type === 'enum' && col.enumLabels) {
      lines.push(
        `CONSTRAINT ${q(enumCheckName(table.name, col.name))} CHECK (${q(col.name)} IN (${col.enumLabels
          .map((l) => literal(l))
          .join(', ')}))`,
      )
    }
  }
  void schema
  return { text: `CREATE TABLE ${q(table.name)} (\n  ${lines.join(',\n  ')}\n)`, parameters: [] }
}

export function enumCheckName(table: string, column: string): string {
  return `${table}_${column}_enum`
}

export function createIndexStatement(table: Table, idx: Index): SqlStatement {
  const columnType = (name: string): PortableType =>
    table.columns.find((c) => c.name === name)?.type ?? 'text'
  // Plain column list: an int64 column stores a canonical decimal string, so equality lookups
  // (the only guaranteed use of a portable index) match exactly. Numeric-aware comparison
  // stays in the WHERE / ORDER BY compilation, not the index access path.
  const cols = idx.columns.map((c) => q(c)).join(', ')
  const where = idx.where ? ` WHERE ${exprToSqlite(idx.where, columnType)}` : ''
  return {
    text: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(idx.name)} ON ${q(table.name)} (${cols})${where}`,
    parameters: [],
  }
}

/** SQLite emulates sequences; the IR still records them, but no DDL is emitted. */
export function createSequenceStatements(_seq: Sequence): SqlStatement[] {
  return []
}

function fkAction(action: string): string {
  switch (action) {
    case 'cascade':
      return 'CASCADE'
    case 'restrict':
      return 'RESTRICT'
    case 'set-null':
      return 'SET NULL'
    default:
      return 'NO ACTION'
  }
}
