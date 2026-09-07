import {
  type DbRow,
  type Expr,
  findColumn,
  findTable,
  type Json,
  type PortableType,
  type SqlStatement,
  type SqlValue,
  sql,
} from '@supakernel/contracts'
import { checkRowAllowed, principalGucs } from '@supakernel/policy'
import type { DatabaseAdapter } from '@supakernel/ports'
import { buildStatement, type StatementSpec } from './compile/statement.js'
import { checkViolationError, dataError, policyDeniedError } from './error-map.js'
import type { ParsedRequest } from './parse-url.js'
import type { DataContext, DataQueryPlan, EmbedNode, ProjectedColumn } from './plan.js'

export interface ExecOutcome {
  /** Projected rows with embeds attached; `Json` values, normalized. */
  readonly rows: ReadonlyArray<Record<string, Json>>
  /** Exact row count after policy, before pagination (`null` unless `count=exact`). */
  readonly total: number | null
  /** Rows affected (mutations). */
  readonly affected: number
}

type Exec = (stmt: SqlStatement) => Promise<readonly DbRow[]>

const AND = (a: Expr | null, b: Expr | null): Expr | null => {
  if (a && b) return { kind: 'logic', op: 'and', terms: [a, b] }
  return a ?? b
}

export async function executeData(
  ctx: DataContext,
  adapter: DatabaseAdapter,
  parsed: ParsedRequest,
  plan: DataQueryPlan,
): Promise<ExecOutcome> {
  if (plan.decision === 'deny') throw policyDeniedError()

  const isPg = ctx.family === 'postgres'
  const gucs = principalGucs(ctx.principal)
  const role = ctx.principal.role

  const scoped = async <T>(readOnly: boolean, fn: (exec: Exec) => Promise<T>): Promise<T> => {
    if (isPg) {
      return adapter.transaction(
        {
          isolation: readOnly ? 'read-committed' : 'serializable',
          ...(readOnly ? { readOnly: true } : {}),
        },
        async (tx) => {
          await tx.execute(sql(`SET LOCAL ROLE ${pgRole(role)}`))
          for (const [k, v] of Object.entries(gucs)) {
            await tx.execute(sql('SELECT set_config($1, $2, true)', [k, v]))
          }
          return fn((s) => tx.execute(s).then((r) => r.rows))
        },
      )
    }
    if (readOnly) return fn((s) => adapter.execute(s).then((r) => r.rows))
    return adapter.transaction({ isolation: 'serializable' }, (tx) =>
      fn((s) => tx.execute(s).then((r) => r.rows)),
    )
  }

  const op = plan.op
  if (op.kind === 'select') return scoped(true, (exec) => runSelect(ctx, exec, plan))
  return scoped(false, (exec) => runMutation(ctx, adapter, exec, parsed, plan))
}

function pgRole(role: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(role) ? `"${role}"` : '"authenticated"'
}

function columnTypeFor(
  ctx: DataContext,
  table: string,
): (name: string) => PortableType | undefined {
  const t = findTable(ctx.schema, table)
  return (name) => (t ? findColumn(t, name)?.type : undefined)
}

async function runSelect(ctx: DataContext, exec: Exec, plan: DataQueryPlan): Promise<ExecOutcome> {
  const op = plan.op
  if (op.kind !== 'select') throw new Error('runSelect: not a select')
  const ct = columnTypeFor(ctx, plan.table)
  const where = AND(op.where, plan.usingForSqlite)

  let total: number | null = null
  if (op.count === 'exact') {
    const countSpec: StatementSpec = {
      kind: 'select',
      table: plan.table,
      columns: [],
      where,
      order: [],
      limit: null,
      offset: null,
      countOnly: true,
      columnType: ct,
    }
    const [row] = await exec(buildStatement(countSpec, ct2dialect(ctx)))
    total = row ? Number((row as Record<string, unknown>).sk_count ?? 0) : 0
  }

  // fetch join keys the embeds need even when the projection hides them (internal, like a JOIN).
  const selectCols = [
    ...new Set([...plan.projection.map((p) => p.name), ...plan.embeds.map((e) => e.localColumn)]),
  ]
  const spec: StatementSpec = {
    kind: 'select',
    table: plan.table,
    columns: selectCols,
    where,
    order: op.order,
    limit: op.page ? op.page.limit : null,
    offset: op.page ? op.page.offset : null,
    columnType: ct,
  }
  const raw = await exec(buildStatement(spec, ct2dialect(ctx)))
  const rows = raw.map((r) => projectRow(r, plan.projection))

  await attachEmbeds(ctx, exec, plan.embeds, rows, raw)
  return { rows, total, affected: rows.length }
}

async function runMutation(
  ctx: DataContext,
  adapter: DatabaseAdapter,
  exec: Exec,
  _parsed: ParsedRequest,
  plan: DataQueryPlan,
): Promise<ExecOutcome> {
  const op = plan.op
  const ct = columnTypeFor(ctx, plan.table)
  const dialect = ct2dialect(ctx)
  const table = findTable(ctx.schema, plan.table)
  const allCols = table ? table.columns.map((c) => c.name) : []

  let spec: StatementSpec
  if (op.kind === 'insert') {
    spec = {
      kind: 'insert',
      table: plan.table,
      columns: [...new Set(op.rows.flatMap((r) => Object.keys(r)))],
      rows: op.rows,
      missing: op.missing,
      onConflict: op.onConflict,
      resolution: op.resolution,
      returning: allCols,
      columnType: ct,
    }
  } else if (op.kind === 'update') {
    spec = {
      kind: 'update',
      table: plan.table,
      patch: op.patch,
      where: (AND(op.where, plan.usingForSqlite) ?? { kind: 'literal', value: false }) as Expr,
      returning: allCols,
      columnType: ct,
    }
  } else if (op.kind === 'delete') {
    spec = {
      kind: 'delete',
      table: plan.table,
      where: (AND(op.where, plan.usingForSqlite) ?? { kind: 'literal', value: false }) as Expr,
      returning: allCols,
      columnType: ct,
    }
  } else {
    throw new Error('runMutation: not a mutation')
  }

  const raw = await exec(buildStatement(spec, dialect))
  const full = raw.map((r) => normalizeRow(r))

  // SQLite family: enforce WITH CHECK on the post-image inside this same transaction.
  if (ctx.family === 'sqlite' && (op.kind === 'insert' || op.kind === 'update')) {
    for (const row of full) {
      if (!checkRowAllowed(plan.security, row, ctx.now)) throw checkViolationError()
    }
  }

  const projected = full.map((r) => projectRow(r as DbRow, plan.projection))
  const returning = op.returning === 'minimal' ? [] : projected
  if (returning.length > 0) await attachEmbeds(ctx, exec, plan.embeds, returning, raw)
  void adapter
  return { rows: returning, total: null, affected: raw.length }
}

async function attachEmbeds(
  ctx: DataContext,
  exec: Exec,
  embeds: readonly EmbedNode[],
  parentRows: Array<Record<string, Json>>,
  rawParentRows: readonly DbRow[],
): Promise<void> {
  if (embeds.length === 0 || parentRows.length === 0) return
  for (const embed of embeds) {
    const ct = columnTypeFor(ctx, embed.table)
    const keys = [
      ...new Set(
        rawParentRows
          .map((r) => (r as Record<string, unknown>)[embed.localColumn])
          .filter((v) => v !== null && v !== undefined)
          .map((v) => normalizeScalar(v)),
      ),
    ]
    if (embed.security.decision === 'deny' || keys.length === 0) {
      for (const pr of parentRows) {
        pr[embed.alias] = embed.direction === 'many-to-one' ? null : []
      }
      continue
    }

    const inExpr: Expr = {
      kind: 'compare',
      op: 'in',
      left: { kind: 'column', table: embed.table, name: embed.foreignColumn },
      right: { kind: 'literal', value: keys as Json[] },
    }
    const where = AND(inExpr, ctx.family === 'sqlite' ? embed.security.rowUsing : null)
    const cols = [...new Set([embed.foreignColumn, ...embed.projection.map((p) => p.name)])]
    const spec: StatementSpec = {
      kind: 'select',
      table: embed.table,
      columns: cols,
      where,
      order: [],
      limit: null,
      offset: null,
      columnType: ct,
    }
    const childRaw = await exec(buildStatement(spec, ct2dialect(ctx)))

    const grouped = new Map<string, Array<Record<string, Json>>>()
    for (const cr of childRaw) {
      const fk = normalizeScalar((cr as Record<string, unknown>)[embed.foreignColumn])
      const list = grouped.get(String(fk)) ?? []
      list.push(projectRow(cr, embed.projection))
      grouped.set(String(fk), list)
    }

    parentRows.forEach((pr, i) => {
      const parentKey = String(
        normalizeScalar((rawParentRows[i] as Record<string, unknown>)[embed.localColumn]),
      )
      const matches = grouped.get(parentKey) ?? []
      pr[embed.alias] = embed.direction === 'many-to-one' ? (matches[0] ?? null) : matches
    })
  }
}

function ct2dialect(ctx: DataContext): 'postgres' | 'sqlite' {
  return ctx.family === 'postgres' ? 'postgres' : 'sqlite'
}

function projectRow(row: DbRow, projection: readonly ProjectedColumn[]): Record<string, Json> {
  const out: Record<string, Json> = {}
  const src = row as Record<string, unknown>
  for (const p of projection) {
    out[p.alias] = normalizeScalar(src[p.name])
  }
  return out
}

function normalizeRow(row: DbRow): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k] = normalizeScalar(v)
  return out
}

function normalizeScalar(v: unknown): Json {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString(10)
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  if (typeof v === 'object') {
    // jsonb from postgres.js arrives already parsed
    return v as Json
  }
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

export type { SqlValue }
export { dataError }
