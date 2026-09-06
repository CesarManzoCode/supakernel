import type {
  CheckConstraint,
  Column,
  ColumnDefault,
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
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name`,
    [],
  )

  const tables: Table[] = []
  const sequences: Sequence[] = []

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

    const table = await readTable(driver, name, ddl, unmodeled)
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
    return {
      name: str(c.name),
      type: portable ?? 'text',
      nullable: num(c.notnull) === 0,
      default: parseDefault(c.dflt_value, ddl, str(c.name)),
      generated: /\bGENERATED\b/i.test(columnClause(ddl, str(c.name))),
    }
  })

  const uniques: UniqueConstraint[] = []
  const indexes: Index[] = []
  const idxList = await driver.all(`PRAGMA index_list(${quote(name)})`, [])
  for (const idx of idxList) {
    const idxName = str(idx.name)
    const cols = (await driver.all(`PRAGMA index_info(${quote(idxName)})`, [])).map((r) =>
      str(r.name),
    )
    const origin = str(idx.origin) // 'c' create index, 'u' unique constraint, 'pk'
    if (origin === 'pk') continue
    if (num(idx.unique) === 1 && origin === 'u') {
      uniques.push({ name: idxName, columns: cols })
    }
    indexes.push({
      name: idxName,
      columns: cols,
      unique: num(idx.unique) === 1,
      where: null, // partial-index predicate recovered in L3
    })
    if (idxName.startsWith('sqlite_autoindex')) {
      // autoindex backs a UNIQUE/PK constraint; keep it only as a unique, not a user index
      indexes.pop()
    }
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
  for (const [id, group] of fkGroups) {
    const sorted = [...group].sort((a, b) => num(a.seq) - num(b.seq))
    const first = sorted[0]
    if (!first) continue
    foreignKeys.push({
      name: `${name}_fk_${id}`,
      columns: sorted.map((g) => str(g.from)),
      referencesTable: str(first.table),
      referencesColumns: sorted.map((g) => str(g.to)),
      onDelete: FK_ACTION[str(first.on_delete).toUpperCase()] ?? 'no-action',
      onUpdate: FK_ACTION[str(first.on_update).toUpperCase()] ?? 'no-action',
    })
  }

  return {
    name,
    columns,
    primaryKey: pk.sort((a, b) => a.seq - b.seq).map((p) => p.name),
    uniques,
    foreignKeys,
    checks: parseChecks(ddl, name, unmodeled),
    indexes,
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
  if (/^CURRENT_TIMESTAMP$/i.test(v) || /^\(datetime\('now'\)\)$/i.test(v)) {
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
