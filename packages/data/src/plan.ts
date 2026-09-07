import {
  type Expr,
  type Family,
  findColumn,
  findTable,
  type PolicyRule,
  type Principal,
  type QueryOperation,
  type SchemaIR,
  type SecurityPlan,
  type Selection,
  type Table,
} from '@supakernel/contracts'
import { buildSecurityPlan } from '@supakernel/policy'
import { dataError, dataUnsupported, unknownRelation } from './errors.js'
import type { ParsedRequest } from './parse-url.js'

export interface DataContext {
  readonly schema: SchemaIR
  readonly policies: readonly PolicyRule[]
  readonly family: Family
  readonly principal: Principal
  readonly now: string
}

export interface ProjectedColumn {
  readonly name: string
  readonly alias: string
}

export interface EmbedNode {
  readonly relation: string
  readonly table: string
  readonly alias: string
  readonly direction: 'many-to-one' | 'one-to-many'
  /** Column on the parent row. */
  readonly localColumn: string
  /** Column on the embedded table. */
  readonly foreignColumn: string
  readonly projection: readonly ProjectedColumn[]
  readonly embeds: readonly EmbedNode[]
  readonly security: SecurityPlan
}

export interface DataQueryPlan {
  readonly op: QueryOperation
  readonly table: string
  readonly decision: 'allow' | 'deny'
  readonly security: SecurityPlan
  readonly projection: readonly ProjectedColumn[]
  readonly embeds: readonly EmbedNode[]
  /** Resolved policy `USING` predicate — spliced into SQL for the SQLite family only. */
  readonly usingForSqlite: Expr | null
  readonly checkForSqlite: Expr | null
}

export function planData(ctx: DataContext, parsed: ParsedRequest): DataQueryPlan {
  const op = parsed.operation
  const table = findTable(ctx.schema, op.table)
  if (!table) throw dataError(unknownRelation('table', op.table))

  const action = op.kind
  const requestedRead = selectionColumnNames(
    op.kind === 'select' ? op.fields : returningSelection(op),
  )
  const requestedWrite = writeColumns(op)

  const security = buildSecurityPlan(
    { schema: ctx.schema, rules: ctx.policies, principal: ctx.principal, now: ctx.now },
    {
      table: op.table,
      action,
      requestedReadFields: requestedRead.explicit,
      requestedWriteFields: requestedWrite,
    },
  )

  const projection =
    security.decision === 'deny'
      ? []
      : resolveProjection(
          op.kind === 'select' ? op.fields : returningSelection(op),
          table,
          security,
        )

  const embeds =
    security.decision === 'deny'
      ? []
      : resolveEmbeds(ctx, op.kind === 'select' ? op.fields : returningSelection(op), table)

  const sqlite = ctx.family === 'sqlite'
  return {
    op,
    table: op.table,
    decision: security.decision,
    security,
    projection,
    embeds,
    usingForSqlite: sqlite ? security.rowUsing : null,
    checkForSqlite: sqlite ? security.rowCheck : null,
  }
}

function returningSelection(op: QueryOperation): readonly Selection[] {
  if (op.kind === 'select') return op.fields
  return op.returning === 'minimal' ? [] : op.returning
}

function selectionColumnNames(fields: readonly Selection[]): {
  explicit: string[]
  hasAll: boolean
} {
  const explicit: string[] = []
  let hasAll = false
  for (const f of fields) {
    if (f.kind === 'all') hasAll = true
    else if (f.kind === 'column') explicit.push(f.name)
  }
  return { explicit, hasAll }
}

function writeColumns(op: QueryOperation): string[] {
  if (op.kind === 'insert') return [...new Set(op.rows.flatMap((r) => Object.keys(r)))]
  if (op.kind === 'update') return Object.keys(op.patch)
  return []
}

function resolveProjection(
  fields: readonly Selection[],
  table: Table,
  security: SecurityPlan,
): ProjectedColumn[] {
  const readable = security.readableFields
  const wantAll = fields.length === 0 || fields.some((f) => f.kind === 'all')
  const out: ProjectedColumn[] = []
  const seen = new Set<string>()

  if (wantAll) {
    for (const c of table.columns) {
      if (readable.has(c.name)) {
        out.push({ name: c.name, alias: c.name })
        seen.add(c.name)
      }
    }
  }
  for (const f of fields) {
    if (f.kind !== 'column') continue
    if (!findColumn(table, f.name)) throw dataError(unknownRelation('column', f.name))
    // an unreadable explicit column was already refused by buildSecurityPlan; guard anyway.
    if (!readable.has(f.name)) continue
    const alias = f.alias ?? f.name
    if (!seen.has(alias)) {
      out.push({ name: f.name, alias })
      seen.add(alias)
    }
  }
  if (out.length === 0 && !wantAll) {
    // every requested column was filtered — still need a stable projection
    for (const c of table.columns)
      if (readable.has(c.name)) out.push({ name: c.name, alias: c.name })
  }
  return out
}

function resolveEmbeds(ctx: DataContext, fields: readonly Selection[], parent: Table): EmbedNode[] {
  const embeds: EmbedNode[] = []
  for (const f of fields) {
    if (f.kind !== 'embed') continue
    const child = findTable(ctx.schema, f.relation)
    if (!child) throw dataError(unknownRelation('relationship', f.relation))

    const rel = resolveRelationship(parent, child)
    const childSecurity = buildSecurityPlan(
      { schema: ctx.schema, rules: ctx.policies, principal: ctx.principal, now: ctx.now },
      { table: child.name, action: 'select' },
    )
    const projection =
      childSecurity.decision === 'deny' ? [] : resolveProjection(f.fields, child, childSecurity)

    embeds.push({
      relation: f.relation,
      table: child.name,
      alias: f.alias ?? f.relation,
      direction: rel.direction,
      localColumn: rel.localColumn,
      foreignColumn: rel.foreignColumn,
      projection,
      embeds: resolveEmbeds(ctx, f.fields, child).length > 0 ? refuseNested() : [],
      security: childSecurity,
    })
  }
  return embeds
}

function refuseNested(): never {
  throw dataError(dataUnsupported('embedding nested more than one hop'))
}

function resolveRelationship(
  parent: Table,
  child: Table,
): { direction: 'many-to-one' | 'one-to-many'; localColumn: string; foreignColumn: string } {
  const toChild = parent.foreignKeys.filter((fk) => fk.referencesTable === child.name)
  const fromChild = child.foreignKeys.filter((fk) => fk.referencesTable === parent.name)

  if (toChild.length + fromChild.length === 0) {
    throw dataError(unknownRelation('relationship', `${parent.name}.${child.name}`))
  }
  if (toChild.length + fromChild.length > 1) {
    throw dataError(
      dataUnsupported(
        `ambiguous relationship between ${parent.name} and ${child.name} (hint required)`,
      ),
    )
  }
  if (toChild.length === 1) {
    const fk = toChild[0] as NonNullable<(typeof toChild)[number]>
    if (fk.columns.length !== 1) throw dataError(dataUnsupported('composite foreign key embedding'))
    return {
      direction: 'many-to-one',
      localColumn: fk.columns[0] as string,
      foreignColumn: fk.referencesColumns[0] as string,
    }
  }
  const fk = fromChild[0] as NonNullable<(typeof fromChild)[number]>
  if (fk.columns.length !== 1) throw dataError(dataUnsupported('composite foreign key embedding'))
  return {
    direction: 'one-to-many',
    localColumn: fk.referencesColumns[0] as string,
    foreignColumn: fk.columns[0] as string,
  }
}
