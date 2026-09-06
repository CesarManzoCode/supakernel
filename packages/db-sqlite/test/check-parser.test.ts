import { describe, expect, it } from 'vitest'
import { parseSqliteCheck, UnsupportedCheckError } from '../src/check-parser.js'

describe('parseSqliteCheck — bounded to the portable Expr grammar', () => {
  it('parses a comparison against a literal', () => {
    expect(parseSqliteCheck('qty >= 0', 'ct_item')).toEqual({
      kind: 'compare',
      op: 'gte',
      left: { kind: 'column', table: 'ct_item', name: 'qty' },
      right: { kind: 'literal', value: 0 },
    })
  })

  it('unwraps the dialect CAST wrapper for int64 columns', () => {
    expect(parseSqliteCheck('CAST(qty AS INTEGER) >= 0', 'ct_item')).toMatchObject({
      op: 'gte',
      left: { kind: 'column', name: 'qty' },
    })
  })

  it('parses AND / OR / NOT and parentheses', () => {
    const e = parseSqliteCheck("(status = 'open' OR status = 'closed') AND NOT archived = 1", 't')
    expect(e).toMatchObject({ kind: 'logic', op: 'and' })
  })

  it('parses IS NULL / IS NOT NULL and IN lists', () => {
    expect(parseSqliteCheck('email IS NOT NULL', 't')).toMatchObject({
      kind: 'not',
      term: { kind: 'compare', op: 'is', right: { kind: 'literal', value: null } },
    })
    expect(parseSqliteCheck("kind IN ('a','b','c')", 't')).toMatchObject({
      kind: 'compare',
      op: 'in',
      right: { kind: 'literal', value: ['a', 'b', 'c'] },
    })
  })

  it.each([
    ['length(name) > 0', 'function call'],
    ['qty + 1 > 0', 'arithmetic'],
    ["name GLOB 'a*'", 'GLOB'],
    ['qty BETWEEN 0 AND 10', 'BETWEEN'],
    ['id IN (SELECT id FROM other)', 'subquery'],
    ["name = 'x' COLLATE NOCASE", 'COLLATE'],
  ])('refuses %s (stable refusal, never silent loss)', (expr) => {
    expect(() => parseSqliteCheck(expr, 't')).toThrow(UnsupportedCheckError)
  })
})
