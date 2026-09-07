import type { Json } from '@supakernel/contracts'

/** One `column=op.value` filter — the single-field subset Realtime supports (contract §15). */
export interface ChangeFilter {
  readonly column: string
  readonly op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'
  readonly value: Json
}

const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'])

export function parseFilter(raw: string | null | undefined): ChangeFilter | null {
  if (!raw) return null
  const eq = raw.indexOf('=')
  if (eq === -1) throw new Error('SK_RT_BAD_FILTER')
  const column = raw.slice(0, eq)
  const rest = raw.slice(eq + 1)
  const dot = rest.indexOf('.')
  if (dot === -1) throw new Error('SK_RT_BAD_FILTER')
  const op = rest.slice(0, dot)
  const valueRaw = rest.slice(dot + 1)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column) || !OPS.has(op)) throw new Error('SK_RT_BAD_FILTER')
  if (op === 'in') {
    const items = valueRaw.replace(/^\(/, '').replace(/\)$/, '').split(',').map(coerce)
    return { column, op: 'in', value: items }
  }
  return { column, op: op as ChangeFilter['op'], value: coerce(valueRaw) }
}

function coerce(s: string): Json {
  const t = s.trim().replace(/^"|"$/g, '')
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

export function matchesFilter(
  filter: ChangeFilter | null,
  row: Record<string, Json> | null,
): boolean {
  if (!filter) return true
  if (!row) return false
  const v = filter.column in row ? row[filter.column] : undefined
  if (v === undefined) return false
  switch (filter.op) {
    case 'eq':
      return v === filter.value
    case 'neq':
      return v !== filter.value
    case 'gt':
      return cmp(v, filter.value) > 0
    case 'gte':
      return cmp(v, filter.value) >= 0
    case 'lt':
      return cmp(v, filter.value) < 0
    case 'lte':
      return cmp(v, filter.value) <= 0
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((x) => x === v)
  }
}

function cmp(a: Json, b: Json): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}
