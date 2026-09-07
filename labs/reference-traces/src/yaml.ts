// Minimal YAML reader for the reference-trace subset (contract §18). Supports nested maps,
// block lists, `[a, b]` flow lists, `>`/`>-`/`|`/`|-` block scalars and plain/quoted scalars
// — no anchors, tags or multi-doc. Deterministic and dependency-free; covered by
// test/audit.test.ts.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

const BLOCK_MARKER_RE = /^(\s*)([^:#\s][^:]*):\s*([|>][+-]?)\s*$/

/** Fold `key: >-` … block scalars into a single `key: "…"` line before tokenizing. */
function foldBlockScalars(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = line.match(BLOCK_MARKER_RE)
    if (!m) {
      out.push(line)
      continue
    }
    const [, indentStr, key, marker] = m as unknown as [string, string, string, string]
    const parentIndent = indentStr.length
    const folded = marker.startsWith('>')
    const body: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const raw = lines[j] ?? ''
      if (raw.trim() === '') {
        body.push('')
        continue
      }
      const ind = raw.length - raw.replace(/^\s*/, '').length
      if (ind <= parentIndent) break
      body.push(raw.slice(parentIndent + 2))
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    const value = folded
      ? body
          .map((l) => l.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      : body.join('\\n')
    out.push(`${indentStr}${key}: ${JSON.stringify(value)}`)
    i = j - 1
  }
  return out.join('\n')
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    return splitFlow(inner).map((part) => parseScalar(part))
  }
  return s
}

function splitFlow(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '[') {
      depth++
      cur += ch
    } else if (ch === ']') {
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

interface Line {
  indent: number
  content: string
}

function tokenize(text: string): Line[] {
  return foldBlockScalars(text)
    .split('\n')
    .map((l) => l.replace(/\t/g, '  '))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, content: l.trim() }))
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
): { value: YamlValue; next: number } {
  if (start >= lines.length) return { value: null, next: start }
  const first = lines[start]
  if (!first) return { value: null, next: start }

  if (first.content.startsWith('- ')) {
    const arr: YamlValue[] = []
    let i = start
    while (i < lines.length) {
      const line = lines[i]
      if (!line || line.indent !== indent || !line.content.startsWith('- ')) break
      const rest = line.content.slice(2)
      if (rest.includes(':') && !rest.startsWith('[') && !/^["']/.test(rest)) {
        const synthetic: Line[] = [{ indent: indent + 2, content: rest }]
        let j = i + 1
        while (j < lines.length && (lines[j]?.indent ?? -1) > indent) {
          synthetic.push(lines[j] as Line)
          j++
        }
        arr.push(parseBlock(synthetic, 0, indent + 2).value)
        i = j
      } else {
        arr.push(parseScalar(rest))
        i++
      }
    }
    return { value: arr, next: i }
  }

  const map: { [k: string]: YamlValue } = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.indent !== indent) break
    const idx = line.content.indexOf(':')
    if (idx === -1) break
    const key = line.content.slice(0, idx).trim()
    const inline = line.content.slice(idx + 1).trim()
    if (inline !== '') {
      map[key] = parseScalar(inline)
      i++
    } else {
      const childIndent = lines[i + 1]?.indent ?? indent
      if (childIndent > indent) {
        const parsed = parseBlock(lines, i + 1, childIndent)
        map[key] = parsed.value
        i = parsed.next
      } else {
        map[key] = null
        i++
      }
    }
  }
  return { value: map, next: i }
}

export function parseYaml(text: string): YamlValue {
  const lines = tokenize(text)
  if (lines.length === 0) return null
  return parseBlock(lines, 0, lines[0]?.indent ?? 0).value
}
