import { type PolicyRule, type PortableType, type Principal, sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSecurityPlan, policyUsingPredicate } from '../src/index.js'
import { notesFixture, type Seat, USER_A, USER_B } from './helpers/fixture.js'

const fx = notesFixture()
const schema = fx.schema
const columnType = (name: string): PortableType | undefined =>
  schema.tables[0]?.columns.find((c) => c.name === name)?.type
const now = '2026-09-06T00:00:00.000Z'

function principal(seat: Seat): Principal {
  return {
    kind: seat.role === 'anon' ? 'anonymous' : 'user',
    subjectId: seat.role === 'anon' ? null : seat.subjectId,
    tenantId: seat.tenantId,
    role: seat.role,
    sessionId: 's',
    claims: { sub: seat.subjectId, tenant_id: seat.tenantId },
    credentialSource: seat.role === 'anon' ? 'none' : 'jwt',
  }
}

describe('policy metamorphic properties (contract §20)', () => {
  const db = openNodeSqlite({ path: ':memory:' })

  async function visible(rules: PolicyRule[], seat: Seat): Promise<string[]> {
    const s = { ...schema, policies: rules }
    const plan = buildSecurityPlan(
      { schema: s, rules, principal: principal(seat), now },
      { table: 'notes', action: 'select' },
    )
    if (plan.decision === 'deny') return []
    const pred = policyUsingPredicate(plan, columnType)
    const where = pred ? ` WHERE ${pred.sql}` : ''
    const r = await db.execute(
      sql(`SELECT title FROM notes${where} ORDER BY title`, pred?.params ?? []),
    )
    return r.rows.map((x) => String(x.title))
  }

  beforeAll(async () => {
    for (const stmt of fx.sqliteDdl) await db.execute(sql(stmt))
    const seed: Array<[string, string, string, string]> = [
      ['n-a1', 'tenant-1', 'user-a', 'A one'],
      ['n-a2', 'tenant-1', 'user-a', 'A two'],
      ['n-b1', 'tenant-1', 'user-b', 'B one'],
      ['n-c1', 'tenant-2', 'user-c', 'C one'],
    ]
    for (const [id, t, o, title] of seed) {
      await db.execute(
        sql('INSERT INTO notes (id,tenant_id,owner_id,title,created_at) VALUES (?,?,?,?,?)', [
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
    await db.close()
  })

  it('adding a restrictive policy never increases the visible set', async () => {
    const before = await visible(fx.policies, USER_A)
    const restricted: PolicyRule = {
      id: 'extra_restrict',
      table: 'notes',
      action: 'select',
      role: 'authenticated',
      mode: 'restrictive',
      using: {
        kind: 'compare',
        op: 'like',
        left: { kind: 'column', table: 'notes', name: 'title' },
        right: { kind: 'literal', value: 'A o%' },
      },
      check: null,
      fields: { read: '*', write: '*', immutable: [] },
    }
    const after = await visible([...fx.policies, restricted], USER_A)
    expect(after.every((x) => before.includes(x))).toBe(true)
    expect(after.length).toBeLessThan(before.length)
  })

  it('removing requested fields does not change which rows match', async () => {
    const s = { ...schema, policies: fx.policies }
    const full = buildSecurityPlan(
      { schema: s, rules: fx.policies, principal: principal(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    const narrow = buildSecurityPlan(
      { schema: s, rules: fx.policies, principal: principal(USER_A), now },
      { table: 'notes', action: 'select', requestedReadFields: ['id'] },
    )
    expect(narrow.rowUsing).toEqual(full.rowUsing)
  })

  it('tenant noninterference: tenant-1 visibility is unchanged by a hostile tenant-2 policy', async () => {
    const baseline = await visible(fx.policies, USER_A)
    const hostile: PolicyRule = {
      id: 'tenant2_grab',
      table: 'notes',
      action: 'select',
      role: 'authenticated',
      mode: 'permissive',
      using: {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'column', table: 'notes', name: 'tenant_id' },
        right: { kind: 'literal', value: 'tenant-2' },
      },
      check: null,
      fields: { read: '*', write: '*', immutable: [] },
    }
    const withHostile = await visible([...fx.policies, hostile], USER_A)
    // the extra permissive rule only OR-adds tenant-2 rows; A is in tenant-1 and the restrictive
    // tenant guard still applies, so A's own view is unchanged.
    expect(withHostile).toEqual(baseline)
  })

  it('no privilege escalation: a rule for one role does not grant another role', async () => {
    const forOther: PolicyRule = {
      id: 'other_role',
      table: 'notes',
      action: 'select',
      role: 'some_other_role',
      mode: 'permissive',
      using: { kind: 'literal', value: true },
      check: null,
      fields: { read: '*', write: '*', immutable: [] },
    }
    const authed = await visible([...fx.policies, forOther], USER_B)
    expect(authed).toEqual(['B one']) // unchanged; the extra rule targets a different role
  })

  it('pagination under a snapshot equals the full result', async () => {
    const plan = buildSecurityPlan(
      {
        schema: { ...schema, policies: fx.policies },
        rules: fx.policies,
        principal: principal(USER_A),
        now,
      },
      { table: 'notes', action: 'select' },
    )
    const pred = policyUsingPredicate(plan, columnType)
    const all = (
      await db.execute(
        sql(`SELECT title FROM notes WHERE ${pred?.sql} ORDER BY title`, pred?.params ?? []),
      )
    ).rows.map((r) => r.title)
    const p1 = (
      await db.execute(
        sql(
          `SELECT title FROM notes WHERE ${pred?.sql} ORDER BY title LIMIT 1 OFFSET 0`,
          pred?.params ?? [],
        ),
      )
    ).rows.map((r) => r.title)
    const p2 = (
      await db.execute(
        sql(
          `SELECT title FROM notes WHERE ${pred?.sql} ORDER BY title LIMIT 1 OFFSET 1`,
          pred?.params ?? [],
        ),
      )
    ).rows.map((r) => r.title)
    expect([...p1, ...p2]).toEqual(all)
  })
})
