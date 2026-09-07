import type { Expr, Json } from '@supakernel/contracts'

/**
 * Convert a libpg-query expression AST node (from a CHECK constraint or a partial-index
 * predicate) into the portable `Expr` grammar (contract §9.2, §30 L3). This walks the *real
 * AST* — it is not a regex or a general SQL parser. Anything outside the portable subset is a
 * stable refusal (`throw UnsupportedExprError`), never a silent loss.
 */
export class UnsupportedExprError extends Error {
  constructor(detail: string) {
    super(`expression is outside the portable Expr subset: ${detail}`)
    this.name = 'UnsupportedExprError'
  }
}

type Node = Record<string, unknown>

function only(node: Node): [string, Node] {
  const keys = Object.keys(node)
  if (keys.length !== 1) throw new UnsupportedExprError(`ambiguous node ${keys.join(',')}`)
  const k = keys[0] as string
  return [k, node[k] as Node]
}

const AEXPR_OP: Record<string, 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike'> = {
  '=': 'eq',
  '<>': 'neq',
  '!=': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  '~~': 'like',
  '~~*': 'ilike',
}

export function astToExpr(raw: unknown, table: string): Expr {
  const [kind, node] = only(raw as Node)
  switch (kind) {
    case 'BoolExpr':
      return boolExpr(node, table)
    case 'A_Expr':
      return aExpr(node, table)
    case 'NullTest':
      return nullTest(node, table)
    case 'ColumnRef':
      return columnRef(node, table)
    case 'A_Const':
      return { kind: 'literal', value: aConst(node) }
    case 'TypeCast':
      // `'v'::text` — a cast on a literal or column is transparent in the portable subset.
      return astToExpr(node.arg, table)
    case 'BooleanTest':
      return booleanTest(node, table)
    default:
      throw new UnsupportedExprError(`node ${kind}`)
  }
}

function boolExpr(node: Node, table: string): Expr {
  const op = String(node.boolop)
  const args = (node.args as unknown[]).map((a) => astToExpr(a, table))
  if (op === 'AND_EXPR') return { kind: 'logic', op: 'and', terms: args }
  if (op === 'OR_EXPR') return { kind: 'logic', op: 'or', terms: args }
  if (op === 'NOT_EXPR') {
    const [term] = args
    if (!term) throw new UnsupportedExprError('empty NOT')
    return { kind: 'not', term }
  }
  throw new UnsupportedExprError(`boolop ${op}`)
}

function aExpr(node: Node, table: string): Expr {
  const exprKind = String(node.kind)
  const name = ((node.name as Node[]) ?? [])
    .map((n) => String((only(n)[1] as { sval?: unknown }).sval ?? ''))
    .join('')

  if (exprKind === 'AEXPR_OP') {
    const op = AEXPR_OP[name]
    if (!op) throw new UnsupportedExprError(`operator ${name}`)
    return {
      kind: 'compare',
      op,
      left: astToExpr(node.lexpr, table),
      right: astToExpr(node.rexpr, table),
    }
  }
  if (exprKind === 'AEXPR_IN') {
    const rexpr = node.rexpr as Node
    const rawItems: unknown[] = Array.isArray(rexpr)
      ? rexpr
      : ((rexpr.List as { items?: unknown[] } | undefined)?.items ?? [])
    const items = rawItems.map((e) => {
      const v = astToExpr(e, table)
      if (v.kind !== 'literal') throw new UnsupportedExprError('IN list must be literals')
      return v.value
    })
    const cmp: Expr = {
      kind: 'compare',
      op: 'in',
      left: astToExpr(node.lexpr, table),
      right: { kind: 'literal', value: items },
    }
    return name === '<>' ? { kind: 'not', term: cmp } : cmp
  }
  if (exprKind === 'AEXPR_LIKE' || exprKind === 'AEXPR_ILIKE') {
    return {
      kind: 'compare',
      op: exprKind === 'AEXPR_LIKE' ? 'like' : 'ilike',
      left: astToExpr(node.lexpr, table),
      right: astToExpr(node.rexpr, table),
    }
  }
  throw new UnsupportedExprError(`A_Expr kind ${exprKind}`)
}

function nullTest(node: Node, table: string): Expr {
  const isNull: Expr = {
    kind: 'compare',
    op: 'is',
    left: astToExpr(node.arg, table),
    right: { kind: 'literal', value: null },
  }
  return String(node.nulltesttype) === 'IS_NOT_NULL' ? { kind: 'not', term: isNull } : isNull
}

function booleanTest(node: Node, table: string): Expr {
  const arg = astToExpr(node.arg, table)
  const t = String(node.booltesttype)
  const trueExpr: Expr = {
    kind: 'compare',
    op: 'eq',
    left: arg,
    right: { kind: 'literal', value: !t.includes('NOT') },
  }
  if (t === 'IS_TRUE' || t === 'IS_NOT_TRUE' || t === 'IS_FALSE' || t === 'IS_NOT_FALSE') {
    return trueExpr
  }
  throw new UnsupportedExprError(`BooleanTest ${t}`)
}

function columnRef(node: Node, table: string): Expr {
  const fields = (node.fields as Node[]).map((f) => {
    const [k, v] = only(f)
    if (k === 'A_Star') throw new UnsupportedExprError('star reference')
    return String((v as { sval?: unknown }).sval ?? '')
  })
  if (fields.length === 1) return { kind: 'column', table, name: fields[0] as string }
  if (fields.length === 2)
    return { kind: 'column', table: fields[0] as string, name: fields[1] as string }
  throw new UnsupportedExprError('qualified column with schema')
}

function aConst(node: Node): Json {
  if ('isnull' in node && node.isnull) return null
  if ('ival' in node) return Number((node.ival as { ival?: number }).ival ?? 0)
  if ('fval' in node) return Number((node.fval as { fval?: string }).fval ?? '0')
  if ('sval' in node) return String((node.sval as { sval?: string }).sval ?? '')
  if ('boolval' in node) return Boolean((node.boolval as { boolval?: boolean }).boolval)
  throw new UnsupportedExprError('unrecognised constant')
}
