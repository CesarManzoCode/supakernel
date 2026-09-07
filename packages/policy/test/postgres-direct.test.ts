import { type SqlValue, sql } from '@supakernel/contracts'
import { openPostgres, type PostgresAdapter } from '@supakernel/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compilePostgresRls, principalGucs } from '../src/index.js'
import { notesFixture, type Seat, USER_A, USER_B, USER_C } from './helpers/fixture.js'
import { deployRls } from './helpers/pg.js'

const URL = process.env.SUPAKERNEL_TEST_PG_URL
const d = URL ? describe : describe.skip

d('native PostgreSQL RLS enforcement (contract §13.1 — direct SQL, no SupaKernel)', () => {
  let db: PostgresAdapter
  const fx = notesFixture('notes_direct')
  const T = fx.table
  const schema = fx.schema
  const NOTES_PG_DDL = fx.pgDdl

  /** Run `fn` in a transaction under `SET LOCAL ROLE` + the principal GUCs, as a request would. */
  async function asSeat<T>(
    seat: Seat & { claims?: Record<string, unknown> },
    fn: (
      exec: (text: string, params?: readonly SqlValue[]) => Promise<Record<string, unknown>[]>,
    ) => Promise<T>,
  ): Promise<T> {
    return db.transaction({ isolation: 'serializable' }, async (tx) => {
      await tx.execute(sql(`SET LOCAL ROLE ${seat.role === '*' ? 'PUBLIC' : `"${seat.role}"`}`))
      const gucs = principalGucs({
        subjectId: seat.subjectId,
        tenantId: seat.tenantId,
        role: seat.role,
        claims: seat.claims ?? { sub: seat.subjectId, tenant_id: seat.tenantId, role: seat.role },
      })
      for (const [k, v] of Object.entries(gucs)) {
        await tx.execute(sql('SELECT set_config($1, $2, true)', [k, v]))
      }
      return fn(
        async (text, params = []) =>
          (await tx.execute(sql(text, params))).rows as Record<string, unknown>[],
      )
    })
  }

  beforeAll(async () => {
    db = openPostgres({ url: URL as string })
    for (const stmt of NOTES_PG_DDL) await db.execute(sql(stmt))
    await deployRls(db, compilePostgresRls(schema, schema.policies))
    // seed as owner (superuser) — RLS is FORCED but the connection user is superuser + BYPASSRLS
    const rows: Array<[string, string, string, string, boolean]> = [
      ['n-a1', USER_A.tenantId, USER_A.subjectId, 'A one', true],
      ['n-a2', USER_A.tenantId, USER_A.subjectId, 'A two', false],
      ['n-b1', USER_B.tenantId, USER_B.subjectId, 'B one', false],
      ['n-c1', USER_C.tenantId, USER_C.subjectId, 'C one', false],
    ]
    await db.execute(sql(`DELETE FROM ${T}`))
    for (const [, t, o, title, secret] of rows) {
      await db.execute(
        sql(
          `INSERT INTO ${T} (id, tenant_id, owner_id, title, secret_flag) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          [t, o, title, secret],
        ),
      )
    }
  })

  afterAll(async () => {
    await db?.close()
  })

  it('SELECT: user A sees only A rows; user B only B rows', async () => {
    const a = await asSeat(USER_A, (x) => x(`SELECT title FROM ${T} ORDER BY title`))
    expect(a.map((r) => r.title)).toEqual(['A one', 'A two'])
    const b = await asSeat(USER_B, (x) => x(`SELECT title FROM ${T} ORDER BY title`))
    expect(b.map((r) => r.title)).toEqual(['B one'])
  })

  it('SELECT: cross-tenant user C sees nothing of tenant-1', async () => {
    const c = await asSeat(USER_C, (x) => x(`SELECT title FROM ${T}`))
    expect(c.map((r) => r.title)).toEqual(['C one'])
  })

  it('SELECT: anon role (no policy) sees nothing — default deny', async () => {
    const anon = await asSeat({ ...USER_A, role: 'anon' }, (x) => x(`SELECT title FROM ${T}`))
    expect(anon).toEqual([])
  })

  it('SELECT: service_role bypasses RLS and sees every row', async () => {
    const s = await asSeat(
      { label: 'svc', subjectId: 'svc', tenantId: USER_A.tenantId, role: 'service_role' },
      (x) => x(`SELECT title FROM ${T}`),
    )
    expect(s.length).toBe(4)
  })

  it('INSERT: A cannot create a row owned by B (WITH CHECK)', async () => {
    await expect(
      asSeat(USER_A, (x) =>
        x(
          `INSERT INTO ${T} (id, tenant_id, owner_id, title) VALUES (gen_random_uuid(), $1, $2, $3)`,
          [USER_A.tenantId, USER_B.subjectId, 'forged'],
        ),
      ),
    ).rejects.toThrow()
    const check = await asSeat(
      { label: 'svc', subjectId: 's', tenantId: 't', role: 'service_role' },
      (x) => x(`SELECT count(*)::int AS n FROM ${T} WHERE title = 'forged'`),
    )
    expect(check[0]?.n).toBe(0)
  })

  it('UPDATE: A updating B row affects 0 rows (USING)', async () => {
    const res = await asSeat(USER_A, (x) =>
      x(`UPDATE ${T} SET title = 'hacked' WHERE title = 'B one' RETURNING id`),
    )
    expect(res).toEqual([])
  })

  it('DELETE: A deleting a cross-tenant row affects 0 rows', async () => {
    await asSeat(USER_A, (x) => x(`DELETE FROM ${T} WHERE title = 'C one'`))
    const c = await asSeat(USER_C, (x) => x(`SELECT title FROM ${T}`))
    expect(c.map((r) => r.title)).toEqual(['C one'])
  })
})
