import {
  type CheckConstraint,
  type Column,
  type ColumnDefault,
  type ForeignKey,
  type ForeignKeyAction,
  type Index,
  isPortableType,
  kernelError,
  type PortableType,
  type ProjectSchema,
  type Sequence,
  type Table,
  type UniqueConstraint,
} from '@supakernel/contracts'
import pgQuery from 'libpg-query'
import { astToExpr, UnsupportedExprError } from './ast-expr.js'

type Node = Record<string, unknown>

/** The one targeted text guard the contract permits (§30 L3): libpg-query's parse output does
 *  not reliably preserve `DEFERRABLE` on a constraint, so a `DEFERRABLE` FK is refused here
 *  before it can be silently accepted. This is NOT generalised to regex parsing. */
const DEFERRABLE_RE = /\bdeferrable\b/i

export class UnsupportedSchemaError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UnsupportedSchemaError'
    this.code = code
  }
}

const PG_TYPE_MAP: Record<string, PortableType> = {
  bool: 'bool',
  boolean: 'bool',
  int2: 'int32',
  smallint: 'int32',
  int4: 'int32',
  int: 'int32',
  integer: 'int32',
  int8: 'int64',
  bigint: 'int64',
  float4: 'float64',
  real: 'float64',
  float8: 'float64',
  'double precision': 'float64',
  numeric: 'decimal',
  decimal: 'decimal',
  text: 'text',
  varchar: 'text',
  'character varying': 'text',
  bpchar: 'text',
  char: 'text',
  character: 'text',
  uuid: 'uuid',
  date: 'date',
  timestamp: 'timestamp',
  'timestamp without time zone': 'timestamp',
  timestamptz: 'timestamptz',
  'timestamp with time zone': 'timestamptz',
  json: 'json',
  jsonb: 'json',
  bytea: 'bytes',
}

const FK_ACTION: Record<string, ForeignKeyAction> = {
  a: 'no-action',
  r: 'restrict',
  c: 'cascade',
  n: 'set-null',
  d: 'no-action',
}

interface ParseResult {
  schema: ProjectSchema
  warnings: string[]
}

export async function parsePgSchema(sql: string): Promise<ParseResult> {
  await pgQuery.loadModule()
  let parsed: { stmts?: { stmt?: Node }[] }
  try {
    parsed = pgQuery.parseSync(sql) as { stmts?: { stmt?: Node }[] }
  } catch (err) {
    throw new UnsupportedSchemaError('SK_SCHEMA_PARSE_ERROR', (err as Error).message)
  }

  const tables = new Map<string, Table>()
  const sequences = new Map<string, Sequence>()
  const enums = new Map<string, readonly string[]>()
  const warnings: string[] = []

  for (const wrapper of parsed.stmts ?? []) {
    const stmt = wrapper.stmt
    if (!stmt) continue
    const [kind, node] = firstEntry(stmt)
    switch (kind) {
      case 'CreateEnumStmt':
        enums.set(qualName(node.typeName), listOfStrings(node.vals))
        break
      case 'CreateSeqStmt':
        registerSequence(sequences, node)
        break
      case 'AlterSeqStmt':
        applyAlterSequence(sequences, node)
        break
      case 'CreateStmt':
        tables.set(String((node.relation as Node).relname), parseCreateTable(node, sql, enums))
        break
      case 'IndexStmt':
        addIndex(tables, node)
        break
      case 'CommentStmt':
      case 'TransactionStmt':
        break
      case 'CreateTrigStmt':
        warnings.push(`trigger ${String((node.trigname as unknown) ?? '?')} ignored by parse-pg`)
        break
      default:
        throw new UnsupportedSchemaError(
          'SK_CAP_SCHEMA_STATEMENT_UNSUPPORTED',
          `statement ${kind} is not supported by the portable schema subset`,
        )
    }
  }

  // Link nextval() defaults to sequence ownership when ALTER SEQUENCE OWNED BY was absent.
  for (const table of tables.values()) {
    for (const col of table.columns) {
      if (col.default?.kind === 'identity') {
        const seq = sequences.get(col.default.sequence)
        if (seq && seq.ownedBy === null) {
          sequences.set(seq.name, { ...seq, ownedBy: `${table.name}.${col.name}` })
        }
      }
    }
  }

  return {
    schema: {
      version: 1,
      tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
      sequences: [...sequences.values()].sort((a, b) => a.name.localeCompare(b.name)),
      policies: [],
    },
    warnings,
  }
}

function firstEntry(node: Node): [string, Node] {
  const k = Object.keys(node)[0] as string
  return [k, node[k] as Node]
}

function qualName(names: unknown): string {
  return listOfStrings(names).join('.')
}

function listOfStrings(list: unknown): string[] {
  return ((list as Node[]) ?? []).map((n) => {
    const [, v] = firstEntry(n)
    return String((v as { sval?: unknown }).sval ?? '')
  })
}

function typeName(typeNode: Node): { base: string } {
  const parts = listOfStrings(typeNode.names).filter((p) => p !== 'pg_catalog')
  return { base: parts.join(' ').toLowerCase() }
}

function portableType(
  typeNode: Node,
  enums: Map<string, readonly string[]>,
): { type: PortableType; enumLabels?: readonly string[] } {
  const { base } = typeName(typeNode)
  const mapped = PG_TYPE_MAP[base]
  if (mapped) return { type: mapped }
  const enumLabels = enums.get(base) ?? enums.get(base.replace(/^public\./, ''))
  if (enumLabels) return { type: 'enum', enumLabels }
  throw new UnsupportedSchemaError(
    'SK_CAP_SCHEMA_TYPE_UNSUPPORTED',
    `column type "${base}" is outside the portable subset`,
  )
}

function registerSequence(sequences: Map<string, Sequence>, node: Node): void {
  const name = String((node.sequence as Node).relname)
  const opts = readSeqOptions(node.options)
  sequences.set(name, {
    name,
    ownedBy: null,
    start: opts.start ?? '1',
    increment: opts.increment ?? '1',
    min: opts.min ?? '1',
    max: opts.max ?? '9223372036854775807',
    cycle: opts.cycle ?? false,
  })
}

function applyAlterSequence(sequences: Map<string, Sequence>, node: Node): void {
  const name = String((node.sequence as Node).relname)
  const existing = sequences.get(name) ?? {
    name,
    ownedBy: null,
    start: '1',
    increment: '1',
    min: '1',
    max: '9223372036854775807',
    cycle: false,
  }
  const opts = readSeqOptions(node.options)
  let ownedBy = existing.ownedBy
  for (const opt of (node.options as Node[]) ?? []) {
    const def = firstEntry(opt)[1] as Node
    if (def.defname === 'owned_by') {
      const items = listOfStrings(
        (def.arg as Node).List ? (def.arg as { List: { items: unknown } }).List.items : [],
      )
      if (items.length >= 2) ownedBy = `${items[items.length - 2]}.${items[items.length - 1]}`
    }
  }
  sequences.set(name, {
    ...existing,
    ownedBy,
    start: opts.start ?? existing.start,
    increment: opts.increment ?? existing.increment,
    min: opts.min ?? existing.min,
    max: opts.max ?? existing.max,
    cycle: opts.cycle ?? existing.cycle,
  })
}

function readSeqOptions(options: unknown): {
  start?: string
  increment?: string
  min?: string
  max?: string
  cycle?: boolean
} {
  const out: { start?: string; increment?: string; min?: string; max?: string; cycle?: boolean } =
    {}
  for (const opt of (options as Node[]) ?? []) {
    const def = firstEntry(opt)[1] as Node
    const dn = String(def.defname)
    const val = def.arg ? intOf(def.arg) : undefined
    if (dn === 'start' && val !== undefined) out.start = val
    else if (dn === 'increment' && val !== undefined) out.increment = val
    else if (dn === 'minvalue' && val !== undefined) out.min = val
    else if (dn === 'maxvalue' && val !== undefined) out.max = val
    else if (dn === 'cycle') out.cycle = true
  }
  return out
}

function intOf(arg: unknown): string | undefined {
  const [k, v] = firstEntry(arg as Node)
  if (k === 'Integer') return String((v as { ival?: number }).ival ?? 0)
  if (k === 'A_Const') {
    const c = v as Node
    if ('ival' in c) return String((c.ival as { ival?: number }).ival ?? 0)
  }
  if (k === 'Float') return String((v as { fval?: string }).fval ?? '')
  return undefined
}

function parseCreateTable(node: Node, sql: string, enums: Map<string, readonly string[]>): Table {
  const name = String((node.relation as Node).relname)
  const columns: Column[] = []
  const primaryKey: string[] = []
  const uniques: UniqueConstraint[] = []
  const foreignKeys: ForeignKey[] = []
  const checks: CheckConstraint[] = []
  let anonUnique = 0
  let anonCheck = 0
  let anonFk = 0

  for (const elt of (node.tableElts as Node[]) ?? []) {
    const [ek, en] = firstEntry(elt)
    if (ek === 'ColumnDef') {
      const col = parseColumn(en, name, enums)
      columns.push(col.column)
      if (col.primaryKey) primaryKey.push(col.column.name)
      for (const u of col.uniques)
        uniques.push({ name: u ?? `${name}_${col.column.name}_key`, columns: [col.column.name] })
      for (const c of col.checks) checks.push(c)
      for (const fk of col.foreignKeys) foreignKeys.push(fk)
    } else if (ek === 'Constraint') {
      const con = en
      const conType = String(con.contype)
      const conName = con.conname ? String(con.conname) : null
      if (DEFERRABLE_RE.test(sql) && (con.deferrable || conType === 'CONSTR_FOREIGN')) {
        // Targeted guard: only refuse when the raw DDL actually contains DEFERRABLE.
        if (rawConstraintIsDeferrable(sql, conName)) {
          throw new UnsupportedSchemaError(
            'SK_CAP_SCHEMA_DEFERRABLE_UNSUPPORTED',
            'DEFERRABLE constraints are not supported in v1',
          )
        }
      }
      if (conType === 'CONSTR_PRIMARY') {
        primaryKey.push(...listOfStrings(con.keys))
      } else if (conType === 'CONSTR_UNIQUE') {
        uniques.push({
          name: conName ?? `${name}_uniq_${++anonUnique}`,
          columns: listOfStrings(con.keys),
        })
      } else if (conType === 'CONSTR_CHECK') {
        checks.push(readCheck(con, name, conName ?? `${name}_check_${++anonCheck}`))
      } else if (conType === 'CONSTR_FOREIGN') {
        foreignKeys.push(readForeignKey(con, name, conName ?? `${name}_fk_${++anonFk}`))
      } else {
        throw new UnsupportedSchemaError(
          'SK_CAP_SCHEMA_CONSTRAINT_UNSUPPORTED',
          `table constraint ${conType} is not supported`,
        )
      }
    } else {
      throw new UnsupportedSchemaError('SK_CAP_SCHEMA_STATEMENT_UNSUPPORTED', `table element ${ek}`)
    }
  }

  return { name, columns, primaryKey, uniques, foreignKeys, checks, indexes: [] }
}

interface ParsedColumn {
  column: Column
  primaryKey: boolean
  uniques: (string | null)[]
  checks: CheckConstraint[]
  foreignKeys: ForeignKey[]
}

function parseColumn(
  node: Node,
  table: string,
  enums: Map<string, readonly string[]>,
): ParsedColumn {
  const cname = String(node.colname)
  const pt = portableType(node.typeName as Node, enums)
  let nullable = true
  let def: ColumnDefault | null = null
  const generated = Boolean(node.generated)
  let primaryKey = false
  const uniques: (string | null)[] = []
  const checks: CheckConstraint[] = []
  const foreignKeys: ForeignKey[] = []

  for (const c of (node.constraints as Node[]) ?? []) {
    const con = firstEntry(c)[1] as Node
    const t = String(con.contype)
    const conName = con.conname ? String(con.conname) : null
    if (t === 'CONSTR_NOTNULL') nullable = false
    else if (t === 'CONSTR_NULL') nullable = true
    else if (t === 'CONSTR_PRIMARY') {
      primaryKey = true
      nullable = false
    } else if (t === 'CONSTR_UNIQUE') uniques.push(conName)
    else if (t === 'CONSTR_DEFAULT') def = readDefault(con.raw_expr)
    else if (t === 'CONSTR_CHECK')
      checks.push(readCheck(con, table, conName ?? `${table}_${cname}_check`))
    else if (t === 'CONSTR_FOREIGN') {
      foreignKeys.push(readColumnForeignKey(con, table, cname, conName ?? `${table}_${cname}_fkey`))
    } else if (t === 'CONSTR_GENERATED') {
      def = { kind: 'identity', sequence: `${table}_${cname}_seq` }
    } else {
      throw new UnsupportedSchemaError(
        'SK_CAP_SCHEMA_CONSTRAINT_UNSUPPORTED',
        `column constraint ${t}`,
      )
    }
  }

  const column: Column = {
    name: cname,
    type: pt.type,
    ...(pt.enumLabels ? { enumLabels: pt.enumLabels } : {}),
    nullable,
    default: def,
    generated,
  }
  if (!isPortableType(column.type)) {
    throw new UnsupportedSchemaError('SK_CAP_SCHEMA_TYPE_UNSUPPORTED', column.type)
  }
  return { column, primaryKey, uniques, checks, foreignKeys }
}

function readDefault(rawExpr: unknown): ColumnDefault | null {
  if (!rawExpr) return null
  const [k, node] = firstEntry(rawExpr as Node)
  if (k === 'FuncCall') {
    const fn = listOfStrings((node as Node).funcname)
      .join('.')
      .toLowerCase()
    if (fn === 'now' || fn === 'current_timestamp' || fn === 'transaction_timestamp') {
      return { kind: 'currentTimestamp' }
    }
    if (fn === 'gen_random_uuid' || fn === 'uuid_generate_v4') return { kind: 'uuidV4' }
    if (fn === 'nextval') {
      const arg = ((node as Node).args as Node[])?.[0]
      if (arg) {
        const [, av] = firstEntry(arg)
        const lit = (av as Node).A_Const ? (av as { A_Const: Node }).A_Const : (av as Node)
        const seq = String((lit as { sval?: { sval?: string } }).sval?.sval ?? '')
          .replace(/^public\./, '')
          .replace(/::regclass$/, '')
        return { kind: 'identity', sequence: seq }
      }
    }
    throw new UnsupportedSchemaError(
      'SK_CAP_SCHEMA_DEFAULT_UNSUPPORTED',
      `default function ${fn}()`,
    )
  }
  if (k === 'A_Const') {
    const c = node as Node
    if ('isnull' in c && c.isnull) return { kind: 'literal', value: null }
    if ('ival' in c)
      return { kind: 'literal', value: Number((c.ival as { ival?: number }).ival ?? 0) }
    if ('fval' in c)
      return { kind: 'literal', value: Number((c.fval as { fval?: string }).fval ?? '0') }
    if ('sval' in c)
      return { kind: 'literal', value: String((c.sval as { sval?: string }).sval ?? '') }
    if ('boolval' in c)
      return { kind: 'literal', value: Boolean((c.boolval as { boolval?: boolean }).boolval) }
  }
  if (k === 'TypeCast') return readDefault((node as Node).arg)
  if (k === 'FuncExpr') return { kind: 'currentTimestamp' }
  throw new UnsupportedSchemaError('SK_CAP_SCHEMA_DEFAULT_UNSUPPORTED', `default expression ${k}`)
}

function readCheck(con: Node, table: string, name: string): CheckConstraint {
  try {
    return { name, expr: astToExpr(con.raw_expr, table) }
  } catch (err) {
    if (err instanceof UnsupportedExprError) {
      throw new UnsupportedSchemaError('SK_CAP_SCHEMA_CHECK_UNSUPPORTED', err.message)
    }
    throw err
  }
}

function readForeignKey(con: Node, _table: string, name: string): ForeignKey {
  return {
    name,
    columns: listOfStrings(con.fk_attrs),
    referencesTable: String((con.pktable as Node).relname),
    referencesColumns: listOfStrings(con.pk_attrs),
    onDelete: FK_ACTION[String(con.fk_del_action)] ?? 'no-action',
    onUpdate: FK_ACTION[String(con.fk_upd_action)] ?? 'no-action',
  }
}

function readColumnForeignKey(con: Node, _table: string, column: string, name: string): ForeignKey {
  return {
    name,
    columns: [column],
    referencesTable: String((con.pktable as Node).relname),
    referencesColumns:
      listOfStrings(con.pk_attrs).length > 0 ? listOfStrings(con.pk_attrs) : ['id'],
    onDelete: FK_ACTION[String(con.fk_del_action)] ?? 'no-action',
    onUpdate: FK_ACTION[String(con.fk_upd_action)] ?? 'no-action',
  }
}

function addIndex(tables: Map<string, Table>, node: Node): void {
  const tableName = String((node.relation as Node).relname)
  const table = tables.get(tableName)
  if (!table) {
    throw new UnsupportedSchemaError(
      'SK_SCHEMA_INDEX_ORPHAN',
      `CREATE INDEX references unknown table ${tableName}`,
    )
  }
  if (node.accessMethod && String(node.accessMethod) !== 'btree') {
    throw new UnsupportedSchemaError(
      'SK_CAP_SCHEMA_INDEX_METHOD_UNSUPPORTED',
      `index method ${String(node.accessMethod)}`,
    )
  }
  const columns = ((node.indexParams as Node[]) ?? []).map((p) => {
    const el = firstEntry(p)[1] as Node
    if (!el.name)
      throw new UnsupportedSchemaError('SK_CAP_SCHEMA_INDEX_EXPR_UNSUPPORTED', 'expression index')
    return String(el.name)
  })
  let where: Index['where'] = null
  if (node.whereClause) {
    try {
      where = astToExpr(node.whereClause, tableName)
    } catch (err) {
      if (err instanceof UnsupportedExprError) {
        throw new UnsupportedSchemaError('SK_CAP_SCHEMA_INDEX_PREDICATE_UNSUPPORTED', err.message)
      }
      throw err
    }
  }
  const index: Index = {
    name: String(node.idxname),
    columns,
    unique: Boolean(node.unique),
    where,
  }
  tables.set(tableName, { ...table, indexes: [...table.indexes, index] })
}

function rawConstraintIsDeferrable(sql: string, conName: string | null): boolean {
  if (!DEFERRABLE_RE.test(sql)) return false
  if (!conName) return DEFERRABLE_RE.test(sql)
  const idx = sql.toLowerCase().indexOf(conName.toLowerCase())
  if (idx < 0) return DEFERRABLE_RE.test(sql)
  return DEFERRABLE_RE.test(sql.slice(idx, idx + 400))
}

export function schemaCapabilityError(err: unknown): ReturnType<typeof kernelError> | null {
  if (err instanceof UnsupportedSchemaError) {
    return kernelError({
      category: 'capability',
      code: err.code,
      message: err.message,
      httpStatus: 422,
    })
  }
  return null
}
