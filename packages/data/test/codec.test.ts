import { describe, expect, it } from 'vitest'
import {
  DataError,
  generateOpenApi,
  parseFilters,
  parsePrefer,
  parseRequest,
  parseSelect,
  toKernelError,
  toPostgrestBody,
} from '../src/index.js'
import { blogSchema } from './helpers/blog.js'

const schema = blogSchema()
const posts = schema.tables.find((t) => t.name === 'posts')
const column = (name: string) => posts?.columns.find((c) => c.name === name)

const headers = (h: Record<string, string> = {}) => new Headers(h)

describe('Data codec (contract §11.1)', () => {
  it('parseSelect: columns, alias, one-hop embed', () => {
    expect(parseSelect('*')).toEqual([{ kind: 'all' }])
    expect(parseSelect('id,title:name')).toEqual([
      { kind: 'column', name: 'id', alias: null },
      { kind: 'column', name: 'name', alias: 'title' },
    ])
    const embed = parseSelect('id, authors(name, bio)')
    expect(embed[1]).toMatchObject({ kind: 'embed', relation: 'authors' })
  })

  it('parsePrefer: return / count / resolution / missing', () => {
    expect(
      parsePrefer('return=representation, count=exact, resolution=merge-duplicates'),
    ).toMatchObject({
      return: 'representation',
      count: 'exact',
      resolution: 'merge',
    })
    expect(parsePrefer('count=planned').unsupported).toContain('count=planned')
  })

  it('parseFilters: eq / in / is null / not / or', () => {
    const p = new URLSearchParams('views=gte.10&title=like.A*&or=(published.eq.true,views.gte.1)')
    const expr = parseFilters(p, 'posts', column)
    expect(expr?.kind).toBe('logic')
    const isNull = parseFilters(new URLSearchParams('body=is.null'), 'posts', column)
    expect(isNull).toEqual({
      kind: 'compare',
      op: 'is',
      left: { kind: 'column', table: 'posts', name: 'body' },
      right: { kind: 'literal', value: null },
    })
  })

  it('parseFilters: int64 value beyond safe integer stays a string', () => {
    const expr = parseFilters(
      new URLSearchParams('secret_score=eq.9223372036854775807'),
      'posts',
      column,
    )
    expect(expr).toMatchObject({ right: { kind: 'literal', value: '9223372036854775807' } })
  })
})

describe('Data refusals (contract §11.2) — no partial execution', () => {
  const cases: Array<[string, RequestInit & { url: string }]> = [
    ['rpc', { url: 'http://x/rest/v1/rpc/foo', method: 'POST', body: '{}' }],
    ['deep embed', { url: 'http://x/rest/v1/posts?select=authors(id,posts(id))', method: 'GET' }],
    ['select cast', { url: 'http://x/rest/v1/posts?select=id::text', method: 'GET' }],
    ['json path filter', { url: 'http://x/rest/v1/posts?body->x=eq.1', method: 'GET' }],
    ['fts operator', { url: 'http://x/rest/v1/posts?title=fts.hello', method: 'GET' }],
    [
      'schema switch',
      { url: 'http://x/rest/v1/posts', method: 'GET', headers: { 'accept-profile': 'private' } },
    ],
    ['csv', { url: 'http://x/rest/v1/posts', method: 'GET', headers: { accept: 'text/csv' } }],
  ]
  for (const [name, init] of cases) {
    it(`refuses ${name} with a stable SK_ code`, () => {
      const h = new Headers(init.headers as HeadersInit)
      let threw: unknown
      try {
        parseRequest(
          {
            method: init.method ?? 'GET',
            url: init.url,
            headers: h,
            ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
          },
          schema,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(DataError)
      expect((threw as DataError).kernelError.code).toMatch(/^SK_CAP_DATA_UNSUPPORTED$/)
    })
  }

  it('PATCH without a filter → SK_DATA_FILTER_REQUIRED', () => {
    expect(() =>
      parseRequest(
        {
          method: 'PATCH',
          url: 'http://x/rest/v1/posts',
          headers: headers(),
          body: { title: 'x' },
        },
        schema,
      ),
    ).toThrowError(/SK_DATA_FILTER_REQUIRED/)
  })

  it('bulk insert with non-uniform keys is rejected before execution', () => {
    expect(() =>
      parseRequest(
        {
          method: 'POST',
          url: 'http://x/rest/v1/posts',
          headers: headers(),
          body: [{ title: 'a' }, { title: 'b', body: 'c' }],
        },
        schema,
      ),
    ).toThrowError(/same keys/)
  })
})

describe('Data error mapping (contract §11.3, §25)', () => {
  it('maps a Postgres unique violation without leaking SQL', () => {
    const ke = toKernelError(Object.assign(new Error('x'), { code: '23505' }))
    expect(ke.code).toBe('23505')
    expect(ke.httpStatus).toBe(409)
    expect(JSON.stringify(toPostgrestBody(ke))).not.toMatch(/INSERT|SELECT/i)
  })

  it('an unknown internal error is redacted to SK_INTERNAL 500', () => {
    const ke = toKernelError(new Error('at /home/app/db.ts:42:10 SELECT secret FROM users'))
    expect(ke.code).toBe('SK_INTERNAL')
    expect(ke.message).toBe('internal error')
    expect(ke.details).toBeNull()
  })
})

describe('OpenAPI generation (contract §11.1)', () => {
  it('is generated from the deployed schema and has a stable ETag', () => {
    const a = generateOpenApi(schema)
    const b = generateOpenApi(schema)
    expect(a.etag).toBe(b.etag)
    const doc = a.document as {
      paths: Record<string, unknown>
      components: { schemas: Record<string, unknown> }
    }
    expect(Object.keys(doc.paths).sort()).toEqual(['/authors', '/posts'])
    expect(doc.components.schemas.posts).toBeDefined()
  })
})
