import type {
  CheckConstraint,
  Column,
  ColumnDefault,
  Expr,
  ForeignKey,
  ForeignKeyAction,
  Index,
  ObservedSchema,
  Sequence,
  Table,
  UniqueConstraint,
  UnmodeledObject,
} from '@supakernel/contracts'
import { parseSqliteCheck, UnsupportedCheckError } from './check-parser.js'
import { portableTypeForSqlite } from './dialect.js'
import type { PhysicalValue, SqliteDriver } from './driver.js'

function str(v: PhysicalValue | undefined): string {
  return v === null || v === undefined ? '' : String(v)
}
function num(v: PhysicalValue | undefined): number {
  return typeof v === 'number' ? v : Number(str(v))
}

const FK_ACTION: Record<string, ForeignKeyAction> = {
  'NO ACTION': 'no-action',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'set-null',
  'SET DEFAULT': 'no-action',
}

/**
 * Read the observed schema from a live SQLite database (contract §9.2, §17.1). Output is
 * normalized and lossless for the portable subset; anything else is reported in `unmodeled`,
 * never dropped. CHECK constraints are recovered through the bounded `Expr` parser — a check
 * outside the grammar is recorded as an `unmodeled` refusal, not silently discarded.
 */
export async function introspectSqlite(driver: SqliteDriver): Promise<ObservedSchema> {
  const unmodeled: UnmodeledObject[] = []
  const masterRows = await driver.all(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       AND name NOT LIKE 'd1\\_%' ESCAPE '\\'
       AND name NOT LIKE '\\_sk\\_%' ESCAPE '\\'
       AND name NOT LIKE '\\_litestream%' ESCAPE '\\'
       AND sql IS NOT NULL
     ORDER BY name`,
    [],
  )

  const tables: Table[] = []
  const sequences: Sequence[] = []
  const indexDdl = new Map<string, string>()
  for (const m of masterRows) {
    if (str(m.type) === 'index') indexDdl.set(str(m.name), str(m.sql))
  }

  for (const m of masterRows) {
    const kind = str(m.type)
    const name = str(m.name)
    const ddl = str(m.sql)

    if (kind === 'trigger') {
      // Managed outbox triggers are expected; anything else is reported.
      if (!name.startsWith('_sk_outbox_')) {
        unmodeled.push({ kind: 'trigger', name, reason: 'non-managed trigger' })
      }
      continue
    }
    if (kind === 'view') {
      unmodeled.push({ kind: 'other', name, reason: 'view' })
      continue
    }
    if (kind !== 'table') continue

    const table = await readTable(driver, name, ddl, indexDdl, unmodeled)
    tables.push(table)

    for (const col of table.columns) {
      if (col.default?.kind === 'identity') {
        sequences.push(identitySequence(col.default.sequence, `${name}.${col.name}`))
      }
    }
  }

  return {
    version: 1,
    tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
    sequences: sequences.sort((a, b) => a.name.localeCompare(b.name)),
    policies: [],
    observedAt: new Date().toISOString(),
    unmodeled,
  }
}

async function readTable(
  driver: SqliteDriver,
  name: string,
  ddl: string,
  indexDdl: Map<string, string>,
  unmodeled: UnmodeledObject[],
): Promise<Table> {
  const info = await driver.all(`PRAGMA table_info(${quote(name)})`, [])
  const pk: Array<{ name: string; seq: number }> = []
  const columns: Column[] = info.map((c) => {
    const declType = str(c.type)
    const portable = portableTypeForSqlite(declType)
    if (portable === null) {
      unmodeled.push({ kind: 'column', name: `${name}.${str(c.name)}`, reason: `type ${declType}` })
    }
    if (num(c.pk) > 0) pk.push({ name: str(c.name), seq: num(c.pk) })
    const pt = portable ?? 'text'
    return {
      name: str(c.name),
      type: pt,
      nullable: num(c.notnull) === 0,
      default: canonicalizeDefault(parseDefault(c.dflt_value, ddl, str(c.name)), pt),
      generated: /\bGENERATED\b/i.test(columnClause(ddl, str(c.name))),
    }
  })

  const uniques: UniqueConstraint[] = []
  const indexes: Index[] = []
  const ddlUniqueNames = parseUniqueConstraintNames(ddl)
  const idxList = await driver.all(`PRAGMA index_list(${quote(name)})`, [])
  for (const idx of idxList) {
    const idxName = str(idx.name)
    const cols = (await driver.all(`PRAGMA index_info(${quote(idxName)})`, [])).map((r) =>
      str(r.name),
    )
    const origin = str(idx.origin) // 'c' create index, 'u' unique constraint, 'pk'
    if (origin === 'pk') continue
    if (num(idx.unique) === 1 && origin === 'u') {
      // Recover the user's CONSTRAINT name from the table DDL, matched by column set.
      const declared = ddlUniqueNames.find((u) => u.columns.join(',') === cols.join(','))
      uniques.push({ name: declared?.name ?? idxName, columns: cols })
      continue
    }
    if (idxName.startsWith('sqlite_autoindex')) continue
    let where: Index['where'] = null
    const wherePart = indexDdl.get(idxName)?.match(/\bWHERE\b(.+)$/is)?.[1]
    if (wherePart) {
      try {
        where = parseSqliteCheck(wherePart, name)
      } catch (err) {
        if (err instanceof UnsupportedCheckError) {
          unmodeled.push({
            kind: 'index',
            name: idxName,
            reason: `partial predicate outside portable Expr subset: ${wherePart.trim()}`,
          })
          continue
        }
        throw err
      }
    }
    indexes.push({ name: idxName, columns: cols, unique: num(idx.unique) === 1, where })
  }

  const foreignKeys: ForeignKey[] = []
  const fkList = await driver.all(`PRAGMA foreign_key_list(${quote(name)})`, [])
  const fkGroups = new Map<number, typeof fkList>()
  for (const fk of fkList) {
    const id = num(fk.id)
    const arr = fkGroups.get(id) ?? []
    arr.push(fk)
    fkGroups.set(id, arr)
  }
  const ddlFkNames = parseForeignKeyConstraintNames(ddl)
  for (const [id, group] of fkGroups) {
    const sorted = [...group].sort((a, b) => num(a.seq) - num(b.seq))
    const first = sorted[0]
    if (!first) continue
    const columns = sorted.map((g) => str(g.from))
    const declared = ddlFkNames.find((f) => f.columns.join(',') === columns.join(','))
    foreignKeys.push({
      name: declared?.name ?? `${name}_fk_${id}`,
      columns,
      referencesTable: str(first.table),
      referencesColumns: sorted.map((g) => str(g.to)),
      onDelete: FK_ACTION[str(first.on_delete).toUpperCase()] ?? 'no-action',
      onUpdate: FK_ACTION[str(first.on_update).toUpperCase()] ?? 'no-action',
    })
  }

  const columnType = (col: string): string => columns.find((c) => c.name === col)?.type ?? 'text'

  // Fold the `<table>_<col>_enum` CHECK back into `column.enumLabels` and drop it from checks.
  const checks: CheckConstraint[] = []
  for (const c of parseChecks(ddl, name, unmodeled)) {
    const expr = coerceExprLiterals(c.expr, columnType)
    const enumCol =
      expr.kind === 'compare' &&
      expr.op === 'in' &&
      expr.left.kind === 'column' &&
      columnType(expr.left.name) === 'enum' &&
      expr.right.kind === 'literal' &&
      Array.isArray(expr.right.value)
        ? { name: expr.left.name, labels: expr.right.value.map(String) }
        : null
    if (enumCol) {
      const col = columns.find((x) => x.name === enumCol.name)
      if (col) (col as { enumLabels?: readonly string[] }).enumLabels = enumCol.labels
      continue
    }
    checks.push({ name: c.name, expr })
  }

  return {
    name,
    columns,
    primaryKey: pk.sort((a, b) => a.seq - b.seq).map((p) => p.name),
    uniques,
    foreignKeys,
    checks,
    indexes: indexes.map((i) => ({
      ...i,
      where: i.where ? coerceExprLiterals(i.where, columnType) : null,
    })),
  }
}

function parseChecks(ddl: string, table: string, unmodeled: UnmodeledObject[]): CheckConstraint[] {
  const checks: CheckConstraint[] = []
  const re = /(?:CONSTRAINT\s+("?[A-Za-z0-9_]+"?)\s+)?CHECK\s*\(/gi
  let m: RegExpExecArray | null
  let anon = 0
  m = re.exec(ddl)
  while (m !== null) {
    const start = re.lastIndex - 1
    const body = extractParens(ddl, start)
    if (body !== null) {
      const cname = m[1]?.replace(/"/g, '') ?? `${table}_check_${++anon}`
      try {
        checks.push({ name: cname, expr: parseSqliteCheck(body, table) })
      } catch (err) {
        if (err instanceof UnsupportedCheckError) {
          unmodeled.push({
            kind: 'constraint',
            name: cname,
            reason: `CHECK outside portable Expr subset: ${body.trim()}`,
          })
        } else {
          throw err
        }
      }
    }
    m = re.exec(ddl)
  }
  return checks
}

function extractParens(text: string, openIndex: number): string | null {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }
  return null
}

function columnClause(ddl: string, column: string): string {
  const re = new RegExp(`(?:"|\`)?${column}(?:"|\`)?\\s+[^,]*`, 'i')
  return re.exec(ddl)?.[0] ?? ''
}

function parseDefault(
  raw: PhysicalValue | undefined,
  ddl: string,
  column: string,
): ColumnDefault | null {
  const clause = columnClause(ddl, column)
  if (
    /\bAUTOINCREMENT\b/i.test(clause) ||
    /\/\*\s*sk:identity:([A-Za-z0-9_]+)\s*\*\//i.test(clause)
  ) {
    const named = clause.match(/\/\*\s*sk:identity:([A-Za-z0-9_]+)\s*\*\//i)?.[1]
    return { kind: 'identity', sequence: named ?? `${column}_seq` }
  }
  if (raw === null) return null
  const v = String(raw).trim()
  if (
    /^CURRENT_TIMESTAMP$/i.test(v) ||
    /^\(datetime\('now'\)\)$/i.test(v) ||
    /strftime\(\s*'%Y-%m-%dT%H:%M:%f?Z?'\s*,\s*'now'\s*\)/i.test(v)
  ) {
    return { kind: 'currentTimestamp' }
  }
  if (/lower\(hex\(randomblob/i.test(v) || /\/\*\s*sk:uuidv4\s*\*\//i.test(clause)) {
    return { kind: 'uuidV4' }
  }
  if (/^'(.*)'$/.test(v)) return { kind: 'literal', value: v.slice(1, -1) }
  if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'literal', value: Number(v) }
  if (/^(true|false)$/i.test(v)) return { kind: 'literal', value: /true/i.test(v) }
  if (/^null$/i.test(v)) return { kind: 'literal', value: null }
  return { kind: 'literal', value: v }
}

/** Map a physical default back to its portable form for a given column type. */
function canonicalizeDefault(def: ColumnDefault | null, type: string): ColumnDefault | null {
  if (def === null || def.kind !== 'literal') return def
  if (type === 'bool' && (def.value === 0 || def.value === 1)) {
    return { kind: 'literal', value: def.value === 1 }
  }
  if ((type === 'int64' || type === 'decimal') && typeof def.value === 'string') {
    return /^-?\d+(\.\d+)?$/.test(def.value) ? { kind: 'literal', value: Number(def.value) } : def
  }
  return def
}

function identitySequence(seqName: string, ownedBy: string): Sequence {
  return {
    name: seqName,
    ownedBy,
    start: '1',
    increment: '1',
    min: '1',
    max: '9223372036854775807',
    cycle: false,
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * SQLite has no boolean storage class: the dialect emits `col = 1` for a bool comparison. When
 * the compared column is a bool column, coerce the `0` / `1` literal back to `false` / `true`
 * so a round-trip through introspection is lossless.
 */
function coerceExprLiterals(expr: Expr, columnType: (col: string) => string): Expr {
  switch (expr.kind) {
    case 'not':
      return { kind: 'not', term: coerceExprLiterals(expr.term, columnType) }
    case 'logic':
      return {
        kind: 'logic',
        op: expr.op,
        terms: expr.terms.map((t) => coerceExprLiterals(t, columnType)),
      }
    case 'compare': {
      const left = coerceExprLiterals(expr.left, columnType)
      let right = coerceExprLiterals(expr.right, columnType)
      if (
        left.kind === 'column' &&
        columnType(left.name) === 'bool' &&
        right.kind === 'literal' &&
        (right.value === 0 || right.value === 1)
      ) {
        right = { kind: 'literal', value: right.value === 1 }
      }
      return { kind: 'compare', op: expr.op, left, right }
    }
    default:
      return expr
  }
}

function parseConstraintNames(
  ddl: string,
  keyword: 'UNIQUE' | 'FOREIGN KEY',
): Array<{ name: string; columns: string[] }> {
  const out: Array<{ name: string; columns: string[] }> = []
  const re = new RegExp(`CONSTRAINT\\s+("?[A-Za-z0-9_]+"?)\\s+${keyword}\\s*\\(([^)]*)\\)`, 'gi')
  let m = re.exec(ddl)
  while (m !== null) {
    out.push({
      name: (m[1] ?? '').replace(/"/g, ''),
      columns: (m[2] ?? '')
        .split(',')
        .map((c) => c.trim().replace(/"/g, ''))
        .filter((c) => c.length > 0),
    })
    m = re.exec(ddl)
  }
  return out
}

/** Recover `CONSTRAINT "x" UNIQUE (cols)` names from a table's stored DDL. */
function parseUniqueConstraintNames(ddl: string): Array<{ name: string; columns: string[] }> {
  return parseConstraintNames(ddl, 'UNIQUE')
}

/** Recover `CONSTRAINT "x" FOREIGN KEY (cols)` names from a table's stored DDL. */
function parseForeignKeyConstraintNames(ddl: string): Array<{ name: string; columns: string[] }> {
  return parseConstraintNames(ddl, 'FOREIGN KEY')
}
