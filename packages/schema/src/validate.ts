import {
  type Expr,
  exprDepth,
  isPortableType,
  MAX_EXPR_DEPTH,
  type ProjectSchema,
  referencedTables,
  type Table,
} from '@supakernel/contracts'

export interface SchemaProblem {
  readonly code: string
  readonly path: string
  readonly message: string
}

/**
 * Structural / semantic validation of a `SchemaIR` (contract §30 L3). Every problem is a
 * stable code; nothing is silently repaired.
 */
export function validateSchema(schema: ProjectSchema): readonly SchemaProblem[] {
  const problems: SchemaProblem[] = []
  const p = (code: string, path: string, message: string): void => {
    problems.push({ code, path, message })
  }

  if (schema.version !== 1) p('SK_SCHEMA_VERSION', 'version', 'schema version must be 1')

  const tableNames = new Set(schema.tables.map((t) => t.name))
  for (const table of schema.tables) {
    validateTable(table, tableNames, p)
  }

  const columnOwners = new Set<string>()
  for (const table of schema.tables) {
    for (const col of table.columns) columnOwners.add(`${table.name}.${col.name}`)
  }
  for (const seq of schema.sequences) {
    if (seq.ownedBy !== null && !columnOwners.has(seq.ownedBy)) {
      p('SK_SCHEMA_SEQUENCE_OWNER', `sequences.${seq.name}`, `owner ${seq.ownedBy} does not exist`)
    }
    for (const field of ['start', 'increment', 'min', 'max'] as const) {
      if (!/^-?\d+$/.test(seq[field])) {
        p(
          'SK_SCHEMA_SEQUENCE_VALUE',
          `sequences.${seq.name}.${field}`,
          `${field} must be an integer string`,
        )
      }
    }
  }

  return problems
}

function validateTable(
  table: Table,
  tableNames: ReadonlySet<string>,
  p: (code: string, path: string, message: string) => void,
): void {
  const colNames = new Set<string>()
  for (const col of table.columns) {
    if (colNames.has(col.name))
      p('SK_SCHEMA_DUP_COLUMN', `${table.name}.${col.name}`, 'duplicate column')
    colNames.add(col.name)
    if (!isPortableType(col.type)) {
      p('SK_CAP_SCHEMA_TYPE_UNSUPPORTED', `${table.name}.${col.name}`, `type ${col.type}`)
    }
    if (col.type === 'enum' && (!col.enumLabels || col.enumLabels.length === 0)) {
      p('SK_SCHEMA_ENUM_LABELS', `${table.name}.${col.name}`, 'enum column needs enumLabels')
    }
    if (col.default?.kind === 'identity' && col.type !== 'int32' && col.type !== 'int64') {
      p(
        'SK_SCHEMA_IDENTITY_TYPE',
        `${table.name}.${col.name}`,
        'identity default requires an integer type',
      )
    }
  }

  for (const key of table.primaryKey) {
    if (!colNames.has(key))
      p('SK_SCHEMA_PK_COLUMN', `${table.name}.primaryKey`, `unknown column ${key}`)
  }
  for (const u of table.uniques) {
    for (const c of u.columns) {
      if (!colNames.has(c))
        p('SK_SCHEMA_UNIQUE_COLUMN', `${table.name}.${u.name}`, `unknown column ${c}`)
    }
  }
  for (const fk of table.foreignKeys) {
    if (!tableNames.has(fk.referencesTable)) {
      p('SK_SCHEMA_FK_TABLE', `${table.name}.${fk.name}`, `unknown table ${fk.referencesTable}`)
    }
    for (const c of fk.columns) {
      if (!colNames.has(c))
        p('SK_SCHEMA_FK_COLUMN', `${table.name}.${fk.name}`, `unknown column ${c}`)
    }
  }
  for (const check of table.checks) {
    validateExpr(check.expr, table.name, colNames, `${table.name}.${check.name}`, p)
  }
  for (const idx of table.indexes) {
    for (const c of idx.columns) {
      if (!colNames.has(c))
        p('SK_SCHEMA_INDEX_COLUMN', `${table.name}.${idx.name}`, `unknown column ${c}`)
    }
    if (idx.where) validateExpr(idx.where, table.name, colNames, `${table.name}.${idx.name}`, p)
  }
}

function validateExpr(
  expr: Expr,
  table: string,
  colNames: ReadonlySet<string>,
  path: string,
  p: (code: string, path: string, message: string) => void,
): void {
  if (exprDepth(expr) > MAX_EXPR_DEPTH) {
    p('SK_SCHEMA_EXPR_DEPTH', path, `expression exceeds max depth ${MAX_EXPR_DEPTH}`)
  }
  const refs = referencedTables(expr)
  for (const t of refs) {
    if (t !== table)
      p('SK_SCHEMA_EXPR_SCOPE', path, `CHECK / index predicate references another table ${t}`)
  }
  walkColumns(expr, (name) => {
    if (!colNames.has(name)) p('SK_SCHEMA_EXPR_COLUMN', path, `unknown column ${name}`)
  })
}

function walkColumns(expr: Expr, visit: (name: string) => void): void {
  switch (expr.kind) {
    case 'column':
      visit(expr.name)
      return
    case 'not':
      walkColumns(expr.term, visit)
      return
    case 'compare':
      walkColumns(expr.left, visit)
      walkColumns(expr.right, visit)
      return
    case 'logic':
      for (const t of expr.terms) walkColumns(t, visit)
      return
    default:
      return
  }
}
