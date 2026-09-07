import type { Column, CompareOp, Expr, Json, PortableType } from '@supakernel/contracts'
import { dataError, dataUnsupported, malformedFilter } from './errors.js'

export type ColumnLookup = (name: string) => Column | undefined

const OP_MAP: Record<string, CompareOp> = {
  eq: 'eq',
  neq: 'neq',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  like: 'like',
  ilike: 'ilike',
  in: 'in',
  is: 'is',
}

const UNSUPPORTED_OPS = new Set([
  'fts',
  'plfts',
  'phfts',
  'wfts',
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxr',
  'nxl',
  'adj',
  'match',
  'imatch',
  'isdistinct',
])

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

/**
 * Parse PostgREST filter query parameters into a single `Expr` (contract §11.1). Implicit
 * `AND` across params, plus one level of `or=(…)`. `col`, `not.col`, `col=not.op.value` and
 * `col=is.[not.]null` are supported; operators outside the subset raise
 * `SK_CAP_DATA_UNSUPPORTED`, malformed values raise `SK_DATA_MALFORMED_FILTER`.
 */
export function parseFilters(
  params: URLSearchParams,
  table: string,
  column: ColumnLookup,
): Expr | null {
  const terms: Expr[] = []
  for (const [key, value] of params) {
    if (RESERVED.has(key)) continue
    if (key === 'and' || key === 'or') {
      terms.push(parseLogical(key, value, table, column))
      continue
    }
    terms.push(parseOne(key, value, table, column))
  }
  if (terms.length === 0) return null
  if (terms.length === 1) return terms[0] as Expr
  return { kind: 'logic', op: 'and', terms }
}

function parseLogical(op: 'and' | 'or', raw: string, table: string, column: ColumnLookup): Expr {
  const body = raw.trim().replace(/^\(/, '').replace(/\)$/, '')
  const parts = splitTopLevel(body)
  const terms = parts.map((p) => {
    const trimmed = p.trim()
    if (trimmed.startsWith('and(') || trimmed.startsWith('or(')) {
      throw dataError(dataUnsupported('nested and/or in a logical filter'))
    }
    const eq = trimmed.indexOf('.')
    if (eq === -1) throw dataError(malformedFilter(`"${trimmed}" in ${op}()`))
    const col = trimmed.slice(0, eq)
    const rest = trimmed.slice(eq + 1)
    return buildCompare(col, rest, table, column)
  })
  return { kind: 'logic', op, terms }
}

function parseOne(key: string, value: string, table: string, column: ColumnLookup): Expr {
  if (key.includes('->')) throw dataError(dataUnsupported('JSON path filter'))
  let col = key
  let negate = false
  if (col.startsWith('not.')) {
    negate = true
    col = col.slice(4)
  }
  const expr = buildCompare(col, value, table, column)
  return negate ? { kind: 'not', term: expr } : expr
}

function buildCompare(col: string, spec: string, table: string, column: ColumnLookup): Expr {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
    throw dataError(malformedFilter(`invalid column "${col}"`))
  }
  const meta = column(col)
  if (!meta) throw dataError(malformedFilter(`unknown column "${col}"`))

  let rest = spec
  let negate = false
  if (rest.startsWith('not.')) {
    negate = true
    rest = rest.slice(4)
  }
  const dot = rest.indexOf('.')
  if (dot === -1) throw dataError(malformedFilter(`missing operator for "${col}"`))
  const opToken = rest.slice(0, dot)
  const rawValue = rest.slice(dot + 1)

  if (UNSUPPORTED_OPS.has(opToken)) throw dataError(dataUnsupported(`filter operator "${opToken}"`))
  const op = OP_MAP[opToken]
  if (!op) throw dataError(malformedFilter(`unknown operator "${opToken}"`))

  const left: Expr = { kind: 'column', table, name: col }
  let cmp: Expr

  if (op === 'is') {
    const v = rawValue.toLowerCase()
    if (v === 'null') {
      cmp = { kind: 'compare', op: 'is', left, right: { kind: 'literal', value: null } }
    } else if (v === 'not.null') {
      cmp = {
        kind: 'not',
        term: { kind: 'compare', op: 'is', left, right: { kind: 'literal', value: null } },
      }
    } else if (v === 'true' || v === 'false') {
      cmp = { kind: 'compare', op: 'eq', left, right: { kind: 'literal', value: v === 'true' } }
    } else {
      throw dataError(malformedFilter(`is.${rawValue}`))
    }
  } else if (op === 'in') {
    const listBody = rawValue.replace(/^\(/, '').replace(/\)$/, '')
    const items = splitTopLevel(listBody).map((x) => coerce(unquote(x.trim()), meta.type))
    cmp = { kind: 'compare', op: 'in', left, right: { kind: 'literal', value: items } }
  } else if (op === 'like' || op === 'ilike') {
    cmp = {
      kind: 'compare',
      op,
      left,
      right: { kind: 'literal', value: rawValue.replace(/\*/g, '%') },
    }
  } else {
    cmp = {
      kind: 'compare',
      op,
      left,
      right: { kind: 'literal', value: coerce(unquote(rawValue), meta.type) },
    }
  }

  return negate ? { kind: 'not', term: cmp } : cmp
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  return s
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

export function coerce(value: string, type: PortableType): Json {
  switch (type) {
    case 'bool': {
      const v = value.toLowerCase()
      if (['true', 't', '1'].includes(v)) return true
      if (['false', 'f', '0'].includes(v)) return false
      throw dataError(malformedFilter(`invalid boolean "${value}"`))
    }
    case 'int32': {
      if (!/^-?\d+$/.test(value)) throw dataError(malformedFilter(`invalid integer "${value}"`))
      const n = Number(value)
      if (!Number.isSafeInteger(n))
        throw dataError(malformedFilter(`integer out of range "${value}"`))
      return n
    }
    case 'int64': {
      if (!/^-?\d+$/.test(value)) throw dataError(malformedFilter(`invalid int64 "${value}"`))
      const b = BigInt(value)
      return b <= MAX_SAFE && b >= MIN_SAFE ? Number(b) : value
    }
    case 'float64': {
      const n = Number(value)
      if (!Number.isFinite(n)) throw dataError(malformedFilter(`invalid number "${value}"`))
      return n
    }
    case 'decimal':
      if (!/^-?\d+(\.\d+)?$/.test(value))
        throw dataError(malformedFilter(`invalid decimal "${value}"`))
      return value
    default:
      return value
  }
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let inQuote = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"') inQuote = !inQuote
    else if (!inQuote && ch === '(') depth++
    else if (!inQuote && ch === ')') depth--
    else if (!inQuote && ch === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.filter((p) => p.trim() !== '')
}
