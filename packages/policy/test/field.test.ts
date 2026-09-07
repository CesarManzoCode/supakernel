import type { Principal } from '@supakernel/contracts'
import { describe, expect, it } from 'vitest'
import { buildSecurityPlan, fieldForbidden, PolicyValidationError } from '../src/index.js'
import { notesFixture, USER_A } from './helpers/fixture.js'

const now = '2026-09-06T00:00:00.000Z'
const principal: Principal = {
  kind: 'user',
  subjectId: USER_A.subjectId,
  tenantId: USER_A.tenantId,
  role: 'authenticated',
  sessionId: 's',
  claims: { sub: USER_A.subjectId },
  credentialSource: 'jwt',
}

describe('field-level security (contract §13.1)', () => {
  const schema = notesFixture().schema

  it('secret_flag is never readable (excluded, not null-masked)', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal, now },
      { table: 'notes', action: 'select' },
    )
    expect(plan.readableFields.has('secret_flag')).toBe(false)
    expect([...plan.readableFields].sort()).toEqual([
      'body',
      'created_at',
      'id',
      'owner_id',
      'tenant_id',
      'title',
    ])
  })

  it('requesting an unreadable field is refused explicitly', () => {
    expect(() =>
      buildSecurityPlan(
        { schema, rules: schema.policies, principal, now },
        { table: 'notes', action: 'select', requestedReadFields: ['title', 'secret_flag'] },
      ),
    ).toThrowError(PolicyValidationError)
    try {
      buildSecurityPlan(
        { schema, rules: schema.policies, principal, now },
        { table: 'notes', action: 'select', requestedReadFields: ['secret_flag'] },
      )
    } catch (err) {
      expect((err as PolicyValidationError).kernelError).toEqual(
        fieldForbidden('secret_flag', 'read'),
      )
    }
  })

  it('update writable set excludes immutable ownership columns', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal, now },
      { table: 'notes', action: 'update' },
    )
    expect([...plan.writableFields].sort()).toEqual(['body', 'title'])
    expect(plan.writableFields.has('owner_id')).toBe(false)
    expect(plan.writableFields.has('tenant_id')).toBe(false)
  })

  it('writing an immutable field on update is refused', () => {
    expect(() =>
      buildSecurityPlan(
        { schema, rules: schema.policies, principal, now },
        { table: 'notes', action: 'update', requestedWriteFields: ['owner_id'] },
      ),
    ).toThrowError(PolicyValidationError)
  })

  it('insert allows writing ownership columns but not id/created_at', () => {
    const plan = buildSecurityPlan(
      { schema, rules: schema.policies, principal, now },
      { table: 'notes', action: 'insert' },
    )
    expect([...plan.writableFields].sort()).toEqual(['body', 'owner_id', 'tenant_id', 'title'])
  })

  it('field monotonicity: adding a restrictive rule can only shrink the readable set', () => {
    const base = buildSecurityPlan(
      { schema, rules: schema.policies, principal, now },
      { table: 'notes', action: 'select' },
    )
    const tightened = [
      ...schema.policies,
      {
        id: 'notes_restrict_body',
        table: 'notes',
        action: 'select' as const,
        role: 'authenticated',
        mode: 'restrictive' as const,
        using: { kind: 'literal' as const, value: true },
        check: null,
        fields: { read: ['id', 'title'] as string[], write: '*' as const, immutable: [] },
      },
    ]
    const after = buildSecurityPlan(
      { schema: { ...schema, policies: tightened }, rules: tightened, principal, now },
      { table: 'notes', action: 'select' },
    )
    for (const f of after.readableFields) expect(base.readableFields.has(f)).toBe(true)
    expect(after.readableFields.size).toBeLessThan(base.readableFields.size)
  })
})
