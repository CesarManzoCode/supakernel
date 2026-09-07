import { type PortableType, type Principal, sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSecurityPlan, checkRowAllowed, policyUsingPredicate } from '../src/index.js'
import { notesFixture, type Seat, USER_A, USER_B, USER_C } from './helpers/fixture.js'

const fx = notesFixture()
const NOTES_SQLITE_DDL = fx.sqliteDdl
const columnType = (name: string): PortableType | undefined =>
  fx.schema.tables[0]?.columns.find((c) => c.name === name)?.type

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
const READABLE = ['id', 'tenant_id', 'owner_id', 'title', 'body', 'created_at']

describe('SQLite policy predicate rewrite (contract §13.1 — no fetch-all-then-filter)', () => {
  const db = openNodeSqlite({ path: ':memory:' })
  const schema = fx.schema

  async function visibleTitles(seat: Seat): Promise<string[]> {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(seat), now },
      { table: 'notes', action: 'select' },
    )
    if (plan.decision === 'deny') return []
    const pred = policyUsingPredicate(plan, columnType)
    const cols = READABLE.filter((c) => plan.readableFields.has(c))
      .map((c) => `"${c}"`)
      .join(', ')
    const where = pred ? ` WHERE ${pred.sql}` : ''
    const res = await db.execute(
      sql(`SELECT ${cols} FROM notes${where} ORDER BY title`, pred?.params ?? []),
    )
    return res.rows.map((r) => String(r.title))
  }

  beforeAll(async () => {
    for (const stmt of NOTES_SQLITE_DDL) await db.execute(sql(stmt))
    const seed: Array<[string, string, string, string, number]> = [
      ['n-a1', USER_A.tenantId, USER_A.subjectId, 'A one', 1],
      ['n-a2', USER_A.tenantId, USER_A.subjectId, 'A two', 0],
      ['n-b1', USER_B.tenantId, USER_B.subjectId, 'B one', 0],
      ['n-c1', USER_C.tenantId, USER_C.subjectId, 'C one', 0],
    ]
    for (const [id, t, o, title, secret] of seed) {
      await db.execute(
        sql(
          'INSERT INTO notes (id, tenant_id, owner_id, title, secret_flag, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, t, o, title, secret, now],
        ),
      )
    }
  })

  afterAll(async () => {
    await db.close()
  })

  it('the compiled predicate is parameterized, never inlined', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    const pred = policyUsingPredicate(plan, columnType)
    expect(pred?.sql).not.toContain('user-a')
    expect(pred?.sql).not.toContain('tenant-1')
    expect(pred?.params).toEqual(['tenant-1', 'user-a', 'tenant-1'])
  })

  it('user A sees only A rows; B only B; cross-tenant C isolated', async () => {
    expect(await visibleTitles(USER_A)).toEqual(['A one', 'A two'])
    expect(await visibleTitles(USER_B)).toEqual(['B one'])
    expect(await visibleTitles(USER_C)).toEqual(['C one'])
  })

  it('anon (no policy) sees nothing — default deny', async () => {
    expect(
      await visibleTitles({ label: 'anon', subjectId: 'x', tenantId: 'tenant-1', role: 'anon' }),
    ).toEqual([])
  })

  it('secret_flag column is absent from the projection, not null-masked', async () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    const pred = policyUsingPredicate(plan, columnType)
    const cols = READABLE.filter((c) => plan.readableFields.has(c))
      .map((c) => `"${c}"`)
      .join(', ')
    const res = await db.execute(
      sql(`SELECT ${cols} FROM notes WHERE ${pred?.sql} LIMIT 1`, pred?.params ?? []),
    )
    expect(res.rows[0] && 'secret_flag' in res.rows[0]).toBe(false)
  })

  it('INSERT check: A creating a B-owned row is rejected in-transaction', async () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(USER_A), now },
      { table: 'notes', action: 'insert' },
    )
    const forged = { tenant_id: 'tenant-1', owner_id: 'user-b', title: 'forged' }
    expect(checkRowAllowed(plan, forged, now)).toBe(false)
    const legit = { tenant_id: 'tenant-1', owner_id: 'user-a', title: 'mine' }
    expect(checkRowAllowed(plan, legit, now)).toBe(true)

    await expect(
      db.transaction({ isolation: 'serializable' }, async (tx) => {
        if (!checkRowAllowed(plan, forged, now)) throw new Error('SK_POLICY_CHECK_VIOLATION')
        await tx.execute(
          sql('INSERT INTO notes (id, tenant_id, owner_id, title, created_at) VALUES (?,?,?,?,?)', [
            'x',
            'tenant-1',
            'user-b',
            'forged',
            now,
          ]),
        )
      }),
    ).rejects.toThrow('SK_POLICY_CHECK_VIOLATION')
    const check = await db.execute(sql("SELECT count(*) AS n FROM notes WHERE title = 'forged'"))
    expect(Number(check.rows[0]?.n)).toBe(0)
  })

  it('UPDATE using: A updating a B row changes 0 rows', async () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: principal(USER_A), now },
      { table: 'notes', action: 'update' },
    )
    const pred = policyUsingPredicate(plan, columnType)
    const res = await db.execute(
      sql(
        `UPDATE notes SET title = 'hacked' WHERE title = 'B one' AND ${pred?.sql}`,
        pred?.params ?? [],
      ),
    )
    expect(res.rowCount).toBe(0)
  })
})
