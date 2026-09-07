import { anonymousPrincipal, type PolicyRule, type Principal } from '@supakernel/contracts'
import { describe, expect, it } from 'vitest'
import { buildSecurityPlan } from '../src/index.js'
import { notesFixture, USER_A } from './helpers/fixture.js'

function seat(s: { subjectId: string; tenantId: string; role: string }): Principal {
  return {
    kind: 'user',
    subjectId: s.subjectId,
    tenantId: s.tenantId,
    role: s.role,
    sessionId: 'sess-1',
    claims: { sub: s.subjectId, role: s.role, tenant_id: s.tenantId },
    credentialSource: 'jwt',
  }
}

const now = '2026-09-06T00:00:00.000Z'
const fx = notesFixture()
const schema = fx.schema
const noRls = { ...schema, policies: [] }

describe('policy combination law (contract §13.1)', () => {
  it('default deny: RLS-enabled table, role with no permissive rule → deny', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: anonymousPrincipal('tenant-1'), now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('deny')
    expect(plan.readableFields.size).toBe(0)
  })

  it('permissive present → allow, USING = AND(OR(permissive), restrictive)', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal: seat(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('allow')
    expect(plan.rowUsing).toEqual({
      kind: 'logic',
      op: 'and',
      terms: [
        {
          kind: 'logic',
          op: 'and',
          terms: [
            {
              kind: 'compare',
              op: 'eq',
              left: { kind: 'column', table: 'notes', name: 'tenant_id' },
              right: { kind: 'literal', value: 'tenant-1' },
            },
            {
              kind: 'compare',
              op: 'eq',
              left: { kind: 'column', table: 'notes', name: 'owner_id' },
              right: { kind: 'literal', value: 'user-a' },
            },
          ],
        },
        {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'column', table: 'notes', name: 'tenant_id' },
          right: { kind: 'literal', value: 'tenant-1' },
        },
      ],
    })
  })

  it('two permissive rules combine with OR', () => {
    const rules: PolicyRule[] = [
      {
        id: 'p1',
        table: 'notes',
        action: 'select',
        role: 'authenticated',
        mode: 'permissive',
        using: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'column', table: 'notes', name: 'owner_id' },
          right: { kind: 'context', name: 'subjectId' },
        },
        check: null,
        fields: { read: '*', write: '*', immutable: [] },
      },
      {
        id: 'p2',
        table: 'notes',
        action: 'select',
        role: 'authenticated',
        mode: 'permissive',
        using: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'column', table: 'notes', name: 'secret_flag' },
          right: { kind: 'literal', value: false },
        },
        check: null,
        fields: { read: '*', write: '*', immutable: [] },
      },
    ]
    const plan = buildSecurityPlan(
      { schema: { ...schema, policies: rules }, rules, principal: seat(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.rowUsing?.kind).toBe('logic')
    expect((plan.rowUsing as { op: string }).op).toBe('or')
  })

  it('restrictive-only (no permissive) → deny even though restrictive would pass', () => {
    const rules: PolicyRule[] = [
      {
        id: 'r1',
        table: 'notes',
        action: 'select',
        role: 'authenticated',
        mode: 'restrictive',
        using: { kind: 'literal', value: true },
        check: null,
        fields: { read: '*', write: '*', immutable: [] },
      },
    ]
    const plan = buildSecurityPlan(
      { schema: { ...schema, policies: rules }, rules, principal: seat(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('deny')
  })

  it('no RLS on table → allow-all (default deny applies only when RLS enabled)', () => {
    const plan = buildSecurityPlan(
      { schema: noRls, rules: [], principal: anonymousPrincipal('tenant-1'), now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('allow')
    expect(plan.rowUsing).toBeNull()
    expect(plan.readableFields.has('secret_flag')).toBe(true)
  })

  it('service_role via secret key bypasses entirely', () => {
    const principal: Principal = {
      kind: 'service',
      subjectId: null,
      tenantId: 'tenant-1',
      role: 'service_role',
      sessionId: null,
      claims: {},
      credentialSource: 'secret_key',
    }
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal, now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('allow')
    expect(plan.rowUsing).toBeNull()
    expect(plan.readableFields.has('secret_flag')).toBe(true)
  })

  it('role=service_role claim WITHOUT secret_key credential does NOT bypass', () => {
    const principal: Principal = {
      kind: 'user',
      subjectId: 'attacker',
      tenantId: 'tenant-1',
      role: 'service_role',
      sessionId: 's',
      claims: { role: 'service_role' },
      credentialSource: 'jwt',
    }
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal, now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.decision).toBe('deny')
  })

  it('fingerprint is stable and carries no claim values', () => {
    const a = buildSecurityPlan(
      { schema, rules: schema.policies, principal: seat(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    const b = buildSecurityPlan(
      { schema, rules: schema.policies, principal: seat(USER_A), now },
      { table: 'notes', action: 'select' },
    )
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toContain('user-a')
    expect(a.fingerprint).not.toContain('tenant-1')
  })
})
