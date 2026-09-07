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

/** PostgreSQL DDL emission for the portable `SchemaIR` (contract §17.1, §30 L3). */
export const PG_TYPE: Record<PortableType, string> = {
  bool: 'boolean',
  int32: 'integer',
  int64: 'bigint',
  float64: 'double precision',
  decimal: 'numeric',
  text: 'text',
  uuid: 'uuid',
  date: 'date',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  json: 'jsonb',
  bytes: 'bytea',
  enum: 'text', // enums are surfaced as text + a CHECK on the label set in v1
}

function q(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error(`unsafe identifier: ${id}`)
  return `"${id}"`
}

export function exprToPg(expr: Expr): string {
  switch (expr.kind) {
    case 'literal':
      return literal(expr.value)
    case 'column':
      return q(expr.name)
    case 'claim':
    case 'context':
      throw new Error('claim / context references are not valid in a CHECK / index predicate')
    case 'not':
      return `(NOT ${exprToPg(expr.term)})`
    case 'logic':
      return `(${expr.terms.map(exprToPg).join(expr.op === 'and' ? ' AND ' : ' OR ')})`
    case 'compare': {
      const l = exprToPg(expr.left)
      const r = exprToPg(expr.right)
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
          return `(${l} ILIKE ${r})`
        case 'in': {
          if (expr.right.kind !== 'literal' || !Array.isArray(expr.right.value)) {
            throw new Error('IN needs a literal array')
          }
          return `(${l} IN (${expr.right.value.map((v) => literal(v)).join(', ')}))`
        }
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

function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

function defaultClause(def: NonNullable<Column['default']>): string {
  switch (def.kind) {
    case 'literal':
      return literal(def.value)
    case 'currentTimestamp':
      return 'now()'
    case 'uuidV4':
      return 'gen_random_uuid()'
    case 'identity':
      return `nextval('${def.sequence}'::regclass)`
    default:
      return assertNever(def)
  }
}

export function enumTypeName(table: string, column: string): string {
  return `sk_enum_${table}_${column}`
}

function pgColumnType(table: string, col: Column): string {
  if (col.type === 'enum') return q(enumTypeName(table, col.name))
  return PG_TYPE[col.type]
}

function columnClause(table: Table, col: Column): string {
  const parts = [q(col.name), pgColumnType(table.name, col)]
  if (!col.nullable) parts.push('NOT NULL')
  if (col.default) {
    parts.push(
      `DEFAULT ${
        col.type === 'enum' && col.default.kind === 'literal'
          ? `${literal(col.default.value)}::${q(enumTypeName(table.name, col.name))}`
          : defaultClause(col.default)
      }`,
    )
  }
  return parts.join(' ')
}

/** `CREATE TYPE … AS ENUM (…)` statements for the enum columns a table declares. */
export function enumTypeStatements(table: Table): SqlStatement[] {
  return table.columns
    .filter((c) => c.type === 'enum' && c.enumLabels)
    .map((c) => ({
      text: `CREATE TYPE ${q(enumTypeName(table.name, c.name))} AS ENUM (${(c.enumLabels ?? [])
        .map((l) => literal(l))
        .join(', ')})`,
      parameters: [],
    }))
}

export function createTableStatement(_schema: ProjectSchema, table: Table): SqlStatement {
  const lines: string[] = table.columns.map((c) => columnClause(table, c))
  if (table.primaryKey.length > 0) {
    lines.push(
      `CONSTRAINT ${q(`${table.name}_pkey`)} PRIMARY KEY (${table.primaryKey.map(q).join(', ')})`,
    )
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
    lines.push(`CONSTRAINT ${q(c.name)} CHECK ${exprToPg(c.expr)}`)
  }
  // enum columns are backed by a native `CREATE TYPE … AS ENUM`, which enforces the label set.
  return { text: `CREATE TABLE ${q(table.name)} (\n  ${lines.join(',\n  ')}\n)`, parameters: [] }
}

export function createIndexStatement(table: Table, idx: Index): SqlStatement {
  const cols = idx.columns.map(q).join(', ')
  const where = idx.where ? ` WHERE ${exprToPg(idx.where)}` : ''
  return {
    text: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(idx.name)} ON ${q(table.name)} (${cols})${where}`,
    parameters: [],
  }
}

export function createSequenceStatements(seq: Sequence): SqlStatement[] {
  // `OWNED BY` is emitted after the owning table exists (see `sequenceOwnershipStatement`).
  return [
    {
      text:
        `CREATE SEQUENCE ${q(seq.name)} INCREMENT ${seq.increment} MINVALUE ${seq.min} ` +
        `MAXVALUE ${seq.max} START ${seq.start} ${seq.cycle ? 'CYCLE' : 'NO CYCLE'}`,
      parameters: [],
    },
  ]
}

export function sequenceOwnershipStatement(seq: Sequence): SqlStatement | null {
  if (!seq.ownedBy) return null
  const [t, c] = seq.ownedBy.split('.') as [string, string]
  return { text: `ALTER SEQUENCE ${q(seq.name)} OWNED BY ${q(t)}.${q(c)}`, parameters: [] }
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
