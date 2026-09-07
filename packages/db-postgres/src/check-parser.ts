import type { Expr, Json } from '@supakernel/contracts'

/**
 * A parser bounded *exactly* to the portable `Expr` grammar (contract §9.2, §30 L3), for the
 * shape PostgreSQL emits from `pg_get_constraintdef` / `pg_get_indexdef`. It is not a general
 * SQL parser: anything outside the subset — function calls, arithmetic, row constructors,
 * subqueries — is a stable refusal (`throw UnsupportedPgCheckError`), never a silent loss.
 *
 * PostgreSQL rewrites a few forms; the parser recognizes only its own canonical output:
 *   x IN (a, b)      -> x = ANY (ARRAY[a, b])
 *   x LIKE 'p'       -> x ~~ 'p'
 *   x ILIKE 'p'      -> x ~~* 'p'
 *   'v'::text        -> 'v'   (a cast on a literal is stripped)
 */
export class UnsupportedPgCheckError extends Error {
  readonly raw: string
  constructor(raw: string, detail: string) {
    super(`CHECK expression is outside the portable subset (${detail}): ${raw}`)
    this.name = 'UnsupportedPgCheckError'
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
  | { t: 'lbracket' }
  | { t: 'rbracket' }
  | { t: 'comma' }
  | { t: 'dot' }
  | { t: 'cast' }
  | { t: 'kw'; v: string }

const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'null', 'true', 'false', 'any', 'array'])

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
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
    } else if (c === '[') {
      toks.push({ t: 'lbracket' })
      i++
    } else if (c === ']') {
      toks.push({ t: 'rbracket' })
      i++
    } else if (c === ',') {
      toks.push({ t: 'comma' })
      i++
    } else if (src.startsWith('::', i)) {
      toks.push({ t: 'cast' })
      i += 2
    } else if (c === '.') {
      toks.push({ t: 'dot' })
      i++
    } else if (c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'"
          j += 2
          continue
        }
        if (src[j] === "'") break
        s += src[j]
        j++
      }
      if (src[j] !== "'") throw new UnsupportedPgCheckError(src, 'unterminated string')
      toks.push({ t: 'string', v: s })
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== '"') {
        s += src[j]
        j++
      }
      toks.push({ t: 'ident', v: s })
      i = j + 1
    } else if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j++
      toks.push({ t: 'number', v: src.slice(i, j) })
      i = j
    } else if (src.startsWith('~~*', i)) {
      toks.push({ t: 'op', v: '~~*' })
      i += 3
    } else if (src.startsWith('~~', i)) {
      toks.push({ t: 'op', v: '~~' })
      i += 2
    } else if (['<>', '!=', '>=', '<='].includes(src.slice(i, i + 2))) {
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
      throw new UnsupportedPgCheckError(src, `unexpected character "${c}"`)
    }
  }
  return toks
}

const CMP: Record<string, 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike'> = {
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
    if (this.pos !== this.toks.length)
      throw new UnsupportedPgCheckError(this.src, 'trailing tokens')
    return e
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos]
  }
  private next(): Tok {
    const t = this.toks[this.pos]
    if (!t) throw new UnsupportedPgCheckError(this.src, 'unexpected end')
    this.pos++
    return t
  }
  private isKw(v: string): boolean {
    const t = this.peek()
    return t?.t === 'kw' && t.v === v
  }
  private expect(t: Tok['t']): Tok {
    const got = this.next()
    if (got.t !== t) throw new UnsupportedPgCheckError(this.src, `expected ${t}`)
    return got
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
      // Could be a grouping paren or `(expr)`. PG double-wraps the whole check.
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
      // `= ANY (ARRAY[...])` -> IN
      if (t.v === '=' && this.isKw('any')) {
        this.next()
        this.expect('lparen')
        if (!this.isKw('array')) throw new UnsupportedPgCheckError(this.src, 'ANY without ARRAY')
        this.next()
        this.expect('lbracket')
        const items: Json[] = [this.literalOnly()]
        while (this.peek()?.t === 'comma') {
          this.next()
          items.push(this.literalOnly())
        }
        this.expect('rbracket')
        this.expect('rparen')
        return { kind: 'compare', op: 'in', left, right: { kind: 'literal', value: items } }
      }
      const op = CMP[t.v]
      if (!op) throw new UnsupportedPgCheckError(this.src, `operator ${t.v}`)
      return { kind: 'compare', op, left, right: this.operand() }
    }
    if (this.isKw('is')) {
      this.next()
      let negated = false
      if (this.isKw('not')) {
        this.next()
        negated = true
      }
      if (!this.isKw('null'))
        throw new UnsupportedPgCheckError(this.src, 'IS must be followed by NULL')
      this.next()
      const isNull: Expr = {
        kind: 'compare',
        op: 'is',
        left,
        right: { kind: 'literal', value: null },
      }
      return negated ? { kind: 'not', term: isNull } : isNull
    }
    throw new UnsupportedPgCheckError(this.src, 'operand without a comparison')
  }

  private literalOnly(): Json {
    const e = this.operand()
    if (e.kind !== 'literal') throw new UnsupportedPgCheckError(this.src, 'expected a literal')
    return e.value
  }

  private stripCast(): void {
    while (this.peek()?.t === 'cast') {
      this.next()
      // consume the type name (ident, possibly `ident.ident`, possibly with parens like numeric(10,2))
      this.expect('ident')
      if (this.peek()?.t === 'dot') {
        this.next()
        this.expect('ident')
      }
      if (this.peek()?.t === 'lbracket') {
        this.next()
        this.expect('rbracket')
      }
      if (this.peek()?.t === 'lparen') {
        // e.g. character varying(255)
        let depth = 0
        do {
          const tk = this.next()
          if (tk.t === 'lparen') depth++
          else if (tk.t === 'rparen') depth--
        } while (depth > 0)
      }
    }
  }

  private operand(): Expr {
    if (this.peek()?.t === 'lparen') {
      this.next()
      const e = this.operand()
      this.expect('rparen')
      this.stripCast()
      return e
    }
    const t = this.next()
    let result: Expr
    if (t.t === 'number') {
      result = { kind: 'literal', value: Number(t.v) }
    } else if (t.t === 'string') {
      result = { kind: 'literal', value: t.v }
    } else if (t.t === 'kw' && t.v === 'null') {
      result = { kind: 'literal', value: null }
    } else if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) {
      result = { kind: 'literal', value: t.v === 'true' }
    } else if (t.t === 'ident') {
      let table = this.table
      let name = t.v
      if (this.peek()?.t === 'dot') {
        this.next()
        const col = this.expect('ident')
        table = name
        name = (col as { v: string }).v
      }
      if (this.peek()?.t === 'lparen') throw new UnsupportedPgCheckError(this.src, 'function call')
      result = { kind: 'column', table, name }
    } else {
      throw new UnsupportedPgCheckError(this.src, 'unexpected token in operand')
    }
    this.stripCast()
    return result
  }
}

export function parsePgCheck(raw: string, table: string): Expr {
  return new Parser(tokenize(raw), raw, table).parse()
}
