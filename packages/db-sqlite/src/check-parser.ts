import type { Expr, Json } from '@supakernel/contracts'

/**
 * A parser bounded *exactly* to the portable `Expr` grammar (contract §9.2, §30 L3). It is not
 * a general SQL parser: any construct outside the subset — function calls, arithmetic,
 * subqueries, COLLATE, GLOB, BETWEEN, exotic operators — is a stable refusal
 * (`throw UnsupportedCheckError`), never a silent loss.
 */
export class UnsupportedCheckError extends Error {
  readonly raw: string
  constructor(raw: string, detail: string) {
    super(`CHECK expression is outside the portable subset (${detail}): ${raw}`)
    this.name = 'UnsupportedCheckError'
    this.raw = raw
  }
}

type Tok =
  | { t: 'ident'; v: string }
  | { t: 'number'; v: string }
  | { t: 'string'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' }
  | { t: 'dot' }
  | { t: 'kw'; v: string }

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'like',
  'in',
  'is',
  'null',
  'true',
  'false',
  'cast',
  'as',
])
const OP2 = new Set(['<>', '!=', '>=', '<=', '=='])

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const quoted = (open: string, close: string): string => {
    let j = i + 1
    let s = ''
    while (j < src.length) {
      if (src[j] === open && open === "'" && src[j + 1] === "'") {
        s += "'"
        j += 2
        continue
      }
      if (src[j] === close) {
        i = j + 1
        return s
      }
      s += src[j]
      j++
    }
    throw new UnsupportedCheckError(src, 'unterminated quote')
  }

  while (i < src.length) {
    const c = src[i] as string
    if (/\s/.test(c)) {
      i++
    } else if (c === '(') {
      toks.push({ t: 'lparen' })
      i++
    } else if (c === ')') {
      toks.push({ t: 'rparen' })
      i++
    } else if (c === ',') {
      toks.push({ t: 'comma' })
      i++
    } else if (c === '.') {
      toks.push({ t: 'dot' })
      i++
    } else if (c === "'") {
      toks.push({ t: 'string', v: quoted("'", "'") })
    } else if (c === '"' || c === '`') {
      toks.push({ t: 'ident', v: quoted(c, c) })
    } else if (c === '[') {
      toks.push({ t: 'ident', v: quoted('[', ']') })
    } else if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j++
      if (/[eE]/.test(src[j] ?? '')) throw new UnsupportedCheckError(src, 'scientific notation')
      toks.push({ t: 'number', v: src.slice(i, j) })
      i = j
    } else if (OP2.has(src.slice(i, i + 2))) {
      toks.push({ t: 'op', v: src.slice(i, i + 2) })
      i += 2
    } else if (c === '=' || c === '<' || c === '>') {
      toks.push({ t: 'op', v: c })
      i++
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j] as string)) j++
      const word = src.slice(i, j)
      const lower = word.toLowerCase()
      toks.push(KEYWORDS.has(lower) ? { t: 'kw', v: lower } : { t: 'ident', v: word })
      i = j
    } else {
      throw new UnsupportedCheckError(src, `unexpected character "${c}"`)
    }
  }
  return toks
}

const CMP: Record<string, 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'> = {
  '=': 'eq',
  '==': 'eq',
  '<>': 'neq',
  '!=': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
}

class Parser {
  private pos = 0
  private readonly toks: Tok[]
  private readonly src: string
  private readonly table: string

  constructor(toks: Tok[], src: string, table: string) {
    this.toks = toks
    this.src = src
    this.table = table
  }

  parse(): Expr {
    const e = this.or()
    if (this.pos !== this.toks.length) throw new UnsupportedCheckError(this.src, 'trailing tokens')
    return e
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos]
  }
  private next(): Tok {
    const t = this.toks[this.pos]
    if (!t) throw new UnsupportedCheckError(this.src, 'unexpected end')
    this.pos++
    return t
  }
  private isKw(v: string): boolean {
    const t = this.peek()
    return t?.t === 'kw' && t.v === v
  }
  private expect(t: Tok['t']): void {
    if (this.next().t !== t) throw new UnsupportedCheckError(this.src, `expected ${t}`)
  }

  private or(): Expr {
    const terms = [this.and()]
    while (this.isKw('or')) {
      this.next()
      terms.push(this.and())
    }
    return terms.length === 1 ? (terms[0] as Expr) : { kind: 'logic', op: 'or', terms }
  }

  private and(): Expr {
    const terms = [this.notExpr()]
    while (this.isKw('and')) {
      this.next()
      terms.push(this.notExpr())
    }
    return terms.length === 1 ? (terms[0] as Expr) : { kind: 'logic', op: 'and', terms }
  }

  private notExpr(): Expr {
    if (this.isKw('not')) {
      this.next()
      return { kind: 'not', term: this.notExpr() }
    }
    return this.primary()
  }

  private primary(): Expr {
    if (this.peek()?.t === 'lparen') {
      this.next()
      const e = this.or()
      this.expect('rparen')
      return e
    }
    return this.compare()
  }

  private compare(): Expr {
    const left = this.operand()
    const t = this.peek()

    if (t?.t === 'op') {
      this.next()
      const op = CMP[t.v]
      if (!op) throw new UnsupportedCheckError(this.src, `operator ${t.v}`)
      return { kind: 'compare', op, left, right: this.operand() }
    }
    if (this.isKw('like')) {
      this.next()
      return { kind: 'compare', op: 'like', left, right: this.operand() }
    }
    if (this.isKw('in')) {
      this.next()
      this.expect('lparen')
      const items: Json[] = [this.literalOnly()]
      while (this.peek()?.t === 'comma') {
        this.next()
        items.push(this.literalOnly())
      }
      this.expect('rparen')
      return { kind: 'compare', op: 'in', left, right: { kind: 'literal', value: items } }
    }
    if (this.isKw('is')) {
      this.next()
      let negated = false
      if (this.isKw('not')) {
        this.next()
        negated = true
      }
      if (!this.isKw('null'))
        throw new UnsupportedCheckError(this.src, 'IS must be followed by NULL')
      this.next()
      const isNull: Expr = {
        kind: 'compare',
        op: 'is',
        left,
        right: { kind: 'literal', value: null },
      }
      return negated ? { kind: 'not', term: isNull } : isNull
    }
    throw new UnsupportedCheckError(this.src, 'operand without a comparison')
  }

  private literalOnly(): Json {
    const e = this.operand()
    if (e.kind !== 'literal') throw new UnsupportedCheckError(this.src, 'IN list must be literals')
    return e.value
  }

  private operand(): Expr {
    const t = this.next()
    // The SQLite dialect wraps int64 / decimal columns as `CAST(col AS INTEGER|NUMERIC|REAL)`
    // for numeric-aware comparison. That wrapper is the dialect's own canonical emission, so we
    // unwrap it back to the bare column — this is not general SQL parsing.
    if (t.t === 'kw' && t.v === 'cast') {
      this.expect('lparen')
      const inner = this.operand()
      if (!this.isKw('as')) throw new UnsupportedCheckError(this.src, 'CAST without AS')
      this.next()
      const affinity = this.next()
      if (affinity.t !== 'ident' && affinity.t !== 'kw') {
        throw new UnsupportedCheckError(this.src, 'CAST target must be a type name')
      }
      const allowed = ['integer', 'numeric', 'real', 'text']
      if (!allowed.includes(String((affinity as { v: string }).v).toLowerCase())) {
        throw new UnsupportedCheckError(this.src, `CAST to ${(affinity as { v: string }).v}`)
      }
      this.expect('rparen')
      if (inner.kind !== 'column') throw new UnsupportedCheckError(this.src, 'CAST of a non-column')
      return inner
    }
    if (t.t === 'number') {
      const n = Number(t.v)
      if (!Number.isFinite(n)) throw new UnsupportedCheckError(this.src, 'bad number')
      return { kind: 'literal', value: n }
    }
    if (t.t === 'string') return { kind: 'literal', value: t.v }
    if (t.t === 'kw' && t.v === 'null') return { kind: 'literal', value: null }
    if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) {
      return { kind: 'literal', value: t.v === 'true' }
    }
    if (t.t === 'ident') {
      let table = this.table
      let name = t.v
      if (this.peek()?.t === 'dot') {
        this.next()
        const col = this.next()
        if (col.t !== 'ident') throw new UnsupportedCheckError(this.src, 'expected column after .')
        table = name
        name = col.v
      }
      if (this.peek()?.t === 'lparen') throw new UnsupportedCheckError(this.src, 'function call')
      return { kind: 'column', table, name }
    }
    throw new UnsupportedCheckError(this.src, 'unexpected token in operand')
  }
}

/**
 * Parse a SQLite CHECK expression into a portable `Expr`. Throws `UnsupportedCheckError` for
 * anything outside the grammar — the caller records a stable refusal, never a dropped check.
 */
export function parseSqliteCheck(raw: string, table: string): Expr {
  let s = raw.trim()
  // strip a single fully-wrapping paren pair
  while (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim()
  return new Parser(tokenize(s), raw, table).parse()
}

function balanced(s: string): boolean {
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}
