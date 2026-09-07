import type { Selection } from '@supakernel/contracts'
import { dataError, dataUnsupported, malformedFilter } from './errors.js'

/**
 * Parse a PostgREST `select=` list into `Selection[]` (contract §11.1). Supported: `*`, plain
 * columns, `alias:column`, and **one-hop** FK embeddings `rel(...)` / `alias:rel(...)` /
 * `rel!hint(...)`. Rejected as `SK_CAP_DATA_UNSUPPORTED` (§11.2): casts (`col::type`), JSON
 * path (`col->x`), spreads (`...rel(*)`), aggregates, and embeddings nested more than one hop.
 */
export function parseSelect(raw: string | null): readonly Selection[] {
  if (raw === null || raw.trim() === '' || raw.trim() === '*') return [{ kind: 'all' }]
  return splitTopLevel(raw).map((part) => parsePart(part.trim()))
}

function parsePart(part: string): Selection {
  if (part === '*') return { kind: 'all' }
  if (part.includes('::')) throw dataError(dataUnsupported('select cast (col::type)'))
  if (part.includes('->')) throw dataError(dataUnsupported('select JSON path (col->key)'))
  if (part.startsWith('...')) throw dataError(dataUnsupported('select spread (...rel)'))

  const parenIdx = part.indexOf('(')
  if (parenIdx === -1) {
    const { alias, name } = splitAlias(part)
    ensureIdent(name)
    return { kind: 'column', name, alias }
  }

  if (!part.endsWith(')')) throw dataError(malformedFilter(`unbalanced parentheses in "${part}"`))
  const head = part.slice(0, parenIdx)
  const inner = part.slice(parenIdx + 1, -1)
  const { alias, name: relRaw } = splitAlias(head)
  const relation = relRaw.split('!')[0]?.trim() ?? relRaw
  ensureIdent(relation)

  const fields = splitTopLevel(inner).map((f) => {
    const t = f.trim()
    if (t.includes('(')) throw dataError(dataUnsupported('embedding nested more than one hop'))
    return parsePart(t)
  })

  return {
    kind: 'embed',
    relation,
    alias,
    cardinality: 'many', // resolved against the schema FK direction in the planner
    fields: fields.length > 0 ? fields : [{ kind: 'all' }],
  }
}

function splitAlias(s: string): { alias: string | null; name: string } {
  const idx = s.indexOf(':')
  if (idx === -1) return { alias: null, name: s.trim() }
  return { alias: s.slice(0, idx).trim(), name: s.slice(idx + 1).trim() }
}

function ensureIdent(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw dataError(malformedFilter(`invalid identifier "${name}"`))
  }
}

/** Split on top-level commas, respecting one level of parentheses. */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.filter((p) => p.trim() !== '')
}
