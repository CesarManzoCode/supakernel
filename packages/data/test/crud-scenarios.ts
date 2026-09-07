import { type Family, sql } from '@supakernel/contracts'
import { compilePostgresRls } from '@supakernel/policy'
import type { DatabaseAdapter } from '@supakernel/ports'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOG_PG_DDL, BLOG_SQLITE_DDL, blogSchema } from './helpers/blog.js'
import { anon, type Harness, makeHarness, service, user } from './helpers/client.js'
import { deployRls } from './helpers/pg.js'

const schema = blogSchema()
const A = user('user-a', 'tenant-1', 'A')
const B = user('user-b', 'tenant-1', 'B')
const C = user('user-c', 'tenant-2', 'C')
const ANON = anon('tenant-1', 'ANON')
const SVC = service('tenant-1', 'SVC')

const AUTHORS = [
  ['au-a', 'tenant-1', 'user-a', 'Alice'],
  ['au-b', 'tenant-1', 'user-b', 'Bob'],
  ['au-c', 'tenant-2', 'user-c', 'Carol'],
]
const POSTS: Array<[string, string, string, string, string, boolean, number]> = [
  ['p-a1', 'tenant-1', 'user-a', 'au-a', 'A public', true, 10],
  ['p-a2', 'tenant-1', 'user-a', 'au-a', 'A draft', false, 0],
  ['p-b1', 'tenant-1', 'user-b', 'au-b', 'B public', true, 5],
  ['p-c1', 'tenant-2', 'user-c', 'au-c', 'C public', true, 99],
]

/** The shared PostgREST behavioural suite, run against both database families (contract §11.3). */
export function describeCrud(
  family: Family,
  openAdapter: () => DatabaseAdapter | Promise<DatabaseAdapter>,
): void {
  describe(`Data / PostgREST subset — ${family}, real supabase-js (contract §11, §30 L5)`, () => {
    let db: DatabaseAdapter
    let h: Harness

    beforeAll(async () => {
      db = await openAdapter()
      if (family === 'postgres') {
        for (const s of BLOG_PG_DDL) await db.execute(sql(s))
        await deployRls(db, compilePostgresRls(schema, schema.policies))
      } else {
        for (const s of BLOG_SQLITE_DDL) await db.execute(sql(s))
      }
      h = makeHarness({
        adapter: db,
        schema,
        policies: schema.policies,
        family,
        seats: [A, B, C, ANON, SVC],
      })
    })
    afterAll(async () => {
      await db.close()
    })

    const ph = (n: number): string =>
      Array.from({ length: n }, (_, i) => (family === 'postgres' ? `$${i + 1}` : '?')).join(',')

    beforeEach(async () => {
      await db.execute(sql('DELETE FROM posts'))
      await db.execute(sql('DELETE FROM authors'))
      for (const [id, t, u, n] of AUTHORS) {
        await db.execute(
          sql(`INSERT INTO authors (id,tenant_id,user_id,name) VALUES (${ph(4)})`, [id, t, u, n]),
        )
      }
      for (const [id, t, o, author, title, pub, views] of POSTS) {
        await db.execute(
          sql(
            `INSERT INTO posts (id,tenant_id,owner_id,author_id,title,published,views,secret_score,created_at) VALUES (${ph(9)})`,
            [
              id,
              t,
              o,
              author,
              title,
              family === 'sqlite' ? (pub ? 1 : 0) : pub,
              views,
              '9223372036854775807',
              '2026-01-01T00:00:00.000Z',
            ],
          ),
        )
      }
    })

    it('select: authenticated user sees own + published in tenant, not other tenants', async () => {
      const { data, error } = await h.clientFor(A).from('posts').select('title').order('title')
      expect(error).toBeNull()
      expect(data?.map((r) => r.title)).toEqual(['A draft', 'A public', 'B public'])
    })

    it('select: anon sees only published, restricted field set', async () => {
      const { data } = await h.clientFor(ANON).from('posts').select('*').order('title')
      expect(data?.map((r) => r.title)).toEqual(['A public', 'B public', 'C public'])
      expect(data?.[0] && 'owner_id' in data[0]).toBe(false)
      expect(data?.[0] && 'secret_score' in data[0]).toBe(false)
    })

    it('field security: requesting an unreadable column is refused', async () => {
      const bad = await h.clientFor(A).from('posts').select('id,secret_score')
      expect(bad.error?.code).toBe('SK_POLICY_FIELD_UNREADABLE')
    })

    it('filters: eq / in / gte / like / or', async () => {
      const gte = await h.clientFor(A).from('posts').select('title').gte('views', 10)
      expect(gte.data?.map((r) => r.title)).toEqual(['A public'])
      const inList = await h
        .clientFor(A)
        .from('posts')
        .select('title')
        .in('title', ['A draft', 'B public'])
        .order('title')
      expect(inList.data?.map((r) => r.title)).toEqual(['A draft', 'B public'])
      const or = await h
        .clientFor(A)
        .from('posts')
        .select('title')
        .or('views.gte.10,title.like.B*')
        .order('title')
      expect(or.data?.map((r) => r.title)).toEqual(['A public', 'B public'])
    })

    it('count exact is computed after policy, before page', async () => {
      const { data, count } = await h
        .clientFor(A)
        .from('posts')
        .select('title', { count: 'exact' })
        .order('title')
        .range(0, 1)
      expect(count).toBe(3)
      expect(data?.length).toBe(2)
    })

    it('single / maybeSingle cardinality', async () => {
      const one = await h.clientFor(A).from('posts').select('title').eq('title', 'A draft').single()
      expect(one.data?.title).toBe('A draft')
      const none = await h
        .clientFor(A)
        .from('posts')
        .select('title')
        .eq('title', 'nope')
        .maybeSingle()
      expect(none.data).toBeNull()
      expect(none.error).toBeNull()
      const err = await h.clientFor(A).from('posts').select('title').eq('title', 'nope').single()
      expect(err.error?.code).toBe('PGRST116')
    })

    it('one-hop embedding, parent and child policy independent', async () => {
      const fwd = await h
        .clientFor(A)
        .from('posts')
        .select('title, authors(name)')
        .eq('title', 'A public')
        .single()
      expect((fwd.data as { authors: { name: string } }).authors.name).toBe('Alice')
      const rev = await h
        .clientFor(A)
        .from('authors')
        .select('name, posts(title)')
        .eq('user_id', 'user-a')
        .single()
      expect((rev.data as { posts: { title: string }[] }).posts.map((p) => p.title).sort()).toEqual(
        ['A draft', 'A public'],
      )
    })

    it('insert single + bulk atomic, RETURNING representation', async () => {
      const ins = await h
        .clientFor(A)
        .from('posts')
        .insert({ tenant_id: 'tenant-1', owner_id: 'user-a', author_id: 'au-a', title: 'new one' })
        .select('title')
        .single()
      expect(ins.data?.title).toBe('new one')
      const bulk = await h
        .clientFor(A)
        .from('posts')
        .insert([
          {
            tenant_id: 'tenant-1',
            owner_id: 'user-a',
            author_id: 'au-a',
            title: 'bulk 1',
            published: true,
          },
          {
            tenant_id: 'tenant-1',
            owner_id: 'user-a',
            author_id: 'au-a',
            title: 'bulk 2',
            published: true,
          },
        ])
        .select('title')
      expect(bulk.data?.map((r) => r.title).sort()).toEqual(['bulk 1', 'bulk 2'])
    })

    it('insert WITH CHECK: cannot create a row owned by another user', async () => {
      const res = await h
        .clientFor(A)
        .from('posts')
        .insert({ tenant_id: 'tenant-1', owner_id: 'user-b', author_id: 'au-b', title: 'forged' })
      expect(res.error).not.toBeNull()
      const check = await db.execute(sql("SELECT count(*) AS n FROM posts WHERE title = 'forged'"))
      expect(Number(check.rows[0]?.n)).toBe(0)
    })

    it('update: USING scopes rows; immutable owner_id rejected', async () => {
      const ok = await h
        .clientFor(A)
        .from('posts')
        .update({ title: 'renamed' })
        .eq('id', 'p-a2')
        .select('title')
        .single()
      expect(ok.data?.title).toBe('renamed')
      const other = await h
        .clientFor(A)
        .from('posts')
        .update({ title: 'hax' })
        .eq('id', 'p-b1')
        .select()
      expect(other.data).toEqual([])
      const immut = await h
        .clientFor(A)
        .from('posts')
        .update({ owner_id: 'user-x' })
        .eq('id', 'p-a2')
      expect(immut.error?.code).toBe('SK_POLICY_FIELD_UNWRITABLE')
    })

    it('PATCH / DELETE without a filter → SK_DATA_FILTER_REQUIRED', async () => {
      expect((await h.clientFor(A).from('posts').delete()).error?.code).toBe(
        'SK_DATA_FILTER_REQUIRED',
      )
      expect((await h.clientFor(A).from('posts').update({ title: 'x' })).error?.code).toBe(
        'SK_DATA_FILTER_REQUIRED',
      )
    })

    it('delete removes only own rows', async () => {
      await h.clientFor(A).from('posts').delete().eq('id', 'p-a1')
      await h.clientFor(A).from('posts').delete().eq('id', 'p-b1')
      const left = await db.execute(sql('SELECT id FROM posts ORDER BY id'))
      expect(left.rows.map((r) => r.id)).toEqual(['p-a2', 'p-b1', 'p-c1'])
    })

    it('upsert merge = insert check + update using/check', async () => {
      const up = await h
        .clientFor(A)
        .from('authors')
        .upsert(
          { id: 'au-a', tenant_id: 'tenant-1', user_id: 'user-a', name: 'Alice R.' },
          { onConflict: 'id' },
        )
        .select('name')
        .single()
      expect(up.error).toBeNull()
      expect(up.data?.name).toBe('Alice R.')
    })

    it('service_role bypasses policy entirely', async () => {
      const { data } = await h
        .clientFor(SVC)
        .from('posts')
        .select('title,secret_score')
        .order('title')
      expect(data?.length).toBe(4)
      expect(String(data?.[0]?.secret_score)).toBe('9223372036854775807')
    })

    it('unsupported surface returns a stable code with no partial execution', async () => {
      const res = await h.handler(
        new Request('http://sk.test/rest/v1/rpc/do_thing', {
          method: 'POST',
          headers: { apikey: 'A' },
          body: '{}',
        }),
      )
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect((await res.json()).code).toMatch(/^SK_/)
    })

    it('constraint errors do not leak SQL', async () => {
      const res = await h
        .clientFor(B)
        .from('authors')
        .insert({ id: 'au-a', tenant_id: 'tenant-1', user_id: 'user-b', name: 'dup' })
      expect(res.error).not.toBeNull()
      expect(JSON.stringify(res.error)).not.toMatch(/INSERT INTO|SELECT .* FROM/i)
    })

    it('GET /rest/v1/ returns a real OpenAPI document from the deployed schema', async () => {
      const res = await h.handler(
        new Request('http://sk.test/rest/v1/', { headers: { apikey: 'A' } }),
      )
      const doc = await res.json()
      expect(doc.openapi).toMatch(/^3\./)
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/posts', '/authors']))
      expect(res.headers.get('etag')).toBeTruthy()
    })
  })
}
