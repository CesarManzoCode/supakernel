import { type PortableType, type Principal, sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { describe, expect, it } from 'vitest'
import {
  buildSecurityPlan,
  checkRowAllowed,
  compileSqlitePredicate,
  PolicyValidationError,
  policyUsingPredicate,
  resolvePrincipalRefs,
  validatePolicies,
} from '../src/index.js'
import { notesFixture, USER_A, USER_C } from './helpers/fixture.js'

const fx = notesFixture()
const NOTES_SQLITE_DDL = fx.sqliteDdl
const columnType = (name: string): PortableType | undefined =>
  fx.schema.tables[0]?.columns.find((c) => c.name === name)?.type
const now = '2026-09-06T00:00:00.000Z'
const schema = fx.schema

function user(overrides: Partial<Principal>): Principal {
  return {
    kind: 'user',
    subjectId: USER_A.subjectId,
    tenantId: USER_A.tenantId,
    role: 'authenticated',
    sessionId: 's',
    claims: { sub: USER_A.subjectId },
    credentialSource: 'jwt',
    ...overrides,
  }
}

describe('authorization attack catalog (contract §13.2)', () => {
  it('forged `role: service_role` claim without a secret key → default deny, no bypass', () => {
    const plan = buildSecurityPlan(
      {
        schema,
        rules: schema.policies,
        principal: user({ role: 'service_role', claims: { role: 'service_role' } }),
        now,
      },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('deny')
  })

  it('forged tenant_id in the claims bag does not change enforcement (context comes from Principal)', () => {
    const plan = buildSecurityPlan(
      {
        schema,
        rules: schema.policies,
        principal: user({
          tenantId: 'tenant-1',
          claims: { sub: USER_A.subjectId, tenant_id: 'tenant-2' },
        }),
        now,
      },
      { table: 'notes', action: 'select' },
    )
    const pred = policyUsingPredicate(plan, columnType)
    expect(pred?.params).toContain('tenant-1')
    expect(pred?.params).not.toContain('tenant-2')
  })

  it('cross-tenant id enumeration: guessing another tenant’s row id still returns nothing', async () => {
    const db = openNodeSqlite({ path: ':memory:' })
    for (const s of NOTES_SQLITE_DDL) await db.execute(sql(s))
    await db.execute(
      sql('INSERT INTO notes (id,tenant_id,owner_id,title,created_at) VALUES (?,?,?,?,?)', [
        'known-id',
        'tenant-1',
        USER_A.subjectId,
        'secret',
        now,
      ]),
    )
    const plan = buildSecurityPlan(
      {
        schema,
        rules: schema.policies,
        principal: { ...user({}), subjectId: USER_C.subjectId, tenantId: USER_C.tenantId },
        now,
      },
      { table: 'notes', action: 'select' },
    )
    const pred = policyUsingPredicate(plan, columnType)
    const r = await db.execute(
      sql(`SELECT title FROM notes WHERE id = ? AND ${pred?.sql}`, [
        'known-id',
        ...(pred?.params ?? []),
      ]),
    )
    expect(r.rows).toEqual([])
    await db.close()
  })

  it('bulk insert with one forbidden member: the whole batch is rejected', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: user({}), now },
      { table: 'notes', action: 'insert' },
    )
    const rows = [
      { tenant_id: 'tenant-1', owner_id: 'user-a', title: 'ok1' },
      { tenant_id: 'tenant-1', owner_id: 'user-b', title: 'bad' }, // forbidden
      { tenant_id: 'tenant-1', owner_id: 'user-a', title: 'ok2' },
    ]
    expect(rows.every((r) => checkRowAllowed(plan, r, now))).toBe(false)
  })

  it('update-then-privileged-field: owner_id is not writable and is immutable', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: user({}), now },
      { table: 'notes', action: 'update' },
    )
    expect(plan.writableFields.has('owner_id')).toBe(false)
    expect(() =>
      buildSecurityPlan(
        { schema, rules: schema.policies, principal: user({}), now },
        { table: 'notes', action: 'update', requestedWriteFields: ['owner_id'] },
      ),
    ).toThrow(PolicyValidationError)
  })

  it('upsert path switching: both INSERT check and UPDATE using+check are compiled', () => {
    const ins = buildSecurityPlan(
      { schema, rules: schema.policies, principal: user({}), now },
      { table: 'notes', action: 'insert' },
    )
    const upd = buildSecurityPlan(
      { schema, rules: schema.policies, principal: user({}), now },
      { table: 'notes', action: 'update' },
    )
    expect(ins.rowCheck).not.toBeNull()
    expect(upd.rowUsing).not.toBeNull()
    expect(upd.rowCheck).not.toBeNull()
  })

  it('filter timing oracle: a denied decision compiles to a constant `false`, not a row-dependent predicate', () => {
    const plan = buildSecurityPlan(
      {
        schema,
        rules: schema.policies,
        principal: {
          ...user({}),
          role: 'anon',
          kind: 'anonymous',
          subjectId: null,
          credentialSource: 'none',
        },
        now,
      },
      { table: 'notes', action: 'select' },
    )
    expect(plan.rowUsing).toEqual({ kind: 'literal', value: false })
    const pred = policyUsingPredicate(plan, columnType)
    expect(pred?.sql).toBe('?')
    expect(pred?.params).toEqual([false])
  })

  it('SQL injection in a policy column name is rejected by the identifier guard', () => {
    expect(() =>
      compileSqlitePredicate(
        {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'column', table: 'notes', name: 'id"; DROP TABLE notes;--' },
          right: { kind: 'literal', value: 1 },
        },
        columnType,
      ),
    ).toThrow(/unsafe identifier/)
  })

  it('relation alias escape: a policy expression referencing another table fails validation', () => {
    const problems = validatePolicies(schema, [
      {
        id: 'bad_join',
        table: 'notes',
        action: 'select',
        role: 'authenticated',
        mode: 'permissive',
        using: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'column', table: 'other', name: 'x' },
          right: { kind: 'literal', value: 1 },
        },
        check: null,
        fields: { read: '*', write: '*', immutable: [] },
      },
    ])
    expect(problems.some((p) => /another table/.test(p.detail))).toBe(true)
  })

  it('malformed JSON path: an empty claim path is rejected at deploy', () => {
    const problems = validatePolicies(schema, [
      {
        id: 'bad_claim',
        table: 'notes',
        action: 'select',
        role: 'authenticated',
        mode: 'permissive',
        using: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'column', table: 'notes', name: 'owner_id' },
          right: { kind: 'claim', path: [] },
        },
        check: null,
        fields: { read: '*', write: '*', immutable: [] },
      },
    ])
    expect(problems.some((p) => /empty claim path/.test(p.detail))).toBe(true)
  })

  it('unknown table in the operation is refused before any SQL', () => {
    expect(() =>
      buildSecurityPlan(
        { schema, rules: schema.policies, principal: user({}), now },
        { table: 'ghost', action: 'select' },
      ),
    ).toThrow(PolicyValidationError)
  })

  it('claim / context nodes never survive into a compiled predicate', () => {
    const resolved = resolvePrincipalRefs(
      {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'column', table: 'notes', name: 'owner_id' },
        right: { kind: 'claim', path: ['sub'] },
      },
      user({}),
      now,
    )
    const pred = compileSqlitePredicate(resolved, columnType)
    expect(pred.sql).not.toMatch(/claim|context/)
    expect(pred.params).toEqual([USER_A.subjectId])
  })
})
