import { type PortableType, type Principal, type SqlValue, sql } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildSecurityPlan,
  compilePostgresRls,
  policyUsingPredicate,
  principalGucs,
} from '../src/index.js'
import { notesFixture, type Seat, USER_A, USER_B, USER_C } from './helpers/fixture.js'
import { deployRls } from './helpers/pg.js'

const URL = process.env.SUPAKERNEL_TEST_PG_URL
const d = URL ? describe : describe.skip

const fx = notesFixture('notes_xfam')
const T = fx.table
const schema = fx.schema
const columnType = (name: string): PortableType | undefined =>
  schema.tables[0]?.columns.find((c) => c.name === name)?.type

function principal(seat: Seat): Principal {
  return {
    kind: seat.role === 'anon' ? 'anonymous' : 'user',
    subjectId: seat.role === 'anon' ? null : seat.subjectId,
    tenantId: seat.tenantId,
    role: seat.role,
    sessionId: seat.role === 'anon' ? null : 's',
    claims: { sub: seat.subjectId, tenant_id: seat.tenantId, role: seat.role },
    credentialSource: seat.role === 'anon' ? 'none' : 'jwt',
  }
}

const now = '2026-09-06T00:00:00.000Z'
const SEED: Array<[string, string, string, string]> = [
  ['n-a1', USER_A.tenantId, USER_A.subjectId, 'A one'],
  ['n-a2', USER_A.tenantId, USER_A.subjectId, 'A two'],
  ['n-b1', USER_B.tenantId, USER_B.subjectId, 'B one'],
  ['n-c1', USER_C.tenantId, USER_C.subjectId, 'C one'],
]

d('cross-family policy equivalence (contract §13.1, §30 L4 DONE)', () => {
  const pg = openPostgres({ url: URL as string })
  const lite = openNodeSqlite({ path: ':memory:' })

  beforeAll(async () => {
    for (const s of fx.pgDdl) await pg.execute(sql(s))
    await deployRls(pg, compilePostgresRls(schema, schema.policies))
    await pg.execute(sql(`DELETE FROM "${T}"`))
    for (const s of fx.sqliteDdl) await lite.execute(sql(s))
    for (const [id, t, o, title] of SEED) {
      await pg.execute(
        sql(
          `INSERT INTO "${T}" (id,tenant_id,owner_id,title) VALUES (gen_random_uuid(),$1,$2,$3)`,
          [t, o, title],
        ),
      )
      await lite.execute(
        sql(`INSERT INTO "${T}" (id,tenant_id,owner_id,title,created_at) VALUES (?,?,?,?,?)`, [
          id,
          t,
          o,
          title,
          now,
        ]),
      )
    }
  })
  afterAll(async () => {
    await pg.close()
    await lite.close()
  })

  async function pgVisible(seat: Seat): Promise<string[]> {
    return pg.transaction({ isolation: 'serializable', readOnly: true }, async (tx) => {
      await tx.execute(sql(`SET LOCAL ROLE ${seat.role === '*' ? 'PUBLIC' : `"${seat.role}"`}`))
      for (const [k, v] of Object.entries(
        principalGucs({
          subjectId: seat.subjectId,
          tenantId: seat.tenantId,
          role: seat.role,
          claims: {},
        }),
      )) {
        await tx.execute(sql('SELECT set_config($1,$2,true)', [k, v]))
      }
      const r = await tx.execute(sql(`SELECT title FROM "${T}" ORDER BY title`))
      return r.rows.map((x) => String(x.title))
    })
  }

  async function liteVisible(seat: Seat): Promise<string[]> {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(seat), now },
      { table: T, action: 'select' },
    )
    if (plan.decision === 'deny') return []
    const pred = policyUsingPredicate(plan, columnType)
    const where = pred ? ` WHERE ${pred.sql}` : ''
    const r = await lite.execute(
      sql(`SELECT title FROM "${T}"${where} ORDER BY title`, (pred?.params ?? []) as SqlValue[]),
    )
    return r.rows.map((x) => String(x.title))
  }

  for (const seat of [
    USER_A,
    USER_B,
    USER_C,
    { label: 'anon', subjectId: 'x', tenantId: 'tenant-1', role: 'anon' } as Seat,
  ]) {
    it(`SELECT visibility matches PG-native and SQLite-rewrite for seat ${seat.label}`, async () => {
      const [a, b] = await Promise.all([pgVisible(seat), liteVisible(seat)])
      expect(a).toEqual(b)
    })
  }

  it('the SecurityPlan itself does not branch on family', () => {
    const p1 = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(USER_A), now },
      { table: T, action: 'update' },
    )
    const p2 = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(USER_A), now },
      { table: T, action: 'update' },
    )
    expect(p1).toEqual(p2)
    expect(p1.fingerprint).toBe(p2.fingerprint)
  })
})
