import type { Json } from '@supakernel/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_SCENARIOS,
  classify,
  compare,
  DIVERGENCE_REGISTRY,
  newContext,
  normalize,
  validateScenario,
} from '../src/index.js'
import { diffSignature } from '../src/reduce.js'

describe('normalize (contract §19.2)', () => {
  it('is a stable bijection for uuids and preserves distinctness', () => {
    const ctx = newContext()
    const a = normalize(
      [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
      ],
      {
        normalizers: ['uuid-bijection'],
        ctx,
      },
    ) as string[]
    expect(a[0]).toBe('<uuid:1>')
    expect(a[1]).toBe('<uuid:2>')
    expect(a[2]).toBe('<uuid:1>')
  })

  it('collapses timestamps to observed-order ordinals, not to a constant', () => {
    const ctx = newContext()
    const out = normalize(
      ['2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-01-01T00:00:00Z'],
      {
        normalizers: ['timestamp-window'],
        ctx,
      },
    ) as string[]
    expect(out).toEqual(['<ts:1>', '<ts:2>', '<ts:1>'])
  })

  it('never removes an error field — it only rewrites generated identifiers', () => {
    const ctx = newContext()
    const before: Json = {
      error: {
        message: 'duplicate key value violates unique constraint "notes_owner_title_key"',
        code: '23505',
      },
    }
    const after = normalize(before, { normalizers: ['constraint-name'], ctx }) as {
      error: { message: string; code: string }
    }
    expect(after.error.code).toBe('23505')
    expect(after.error.message).toContain('<constraint>')
    expect(after.error.message).not.toContain('notes_owner_title_key')
  })

  it('decodes a JWT to header/claims/validity without keeping the signature', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJpYXQiOjEwMDAsImV4cCI6NDYwMH0.c2ln'
    const ctx = newContext()
    const out = normalize(jwt, { normalizers: ['jwt-claims'], ctx }) as {
      kind: string
      claims: Record<string, unknown>
      validitySeconds: number
    }
    expect(out.kind).toBe('<jwt>')
    expect(out.claims.sub).toBe('user-1')
    expect(out.claims.iat).toBe('<present>')
    expect(out.validitySeconds).toBe(3600)
  })

  it('MUTATION: a normalizer that dropped a row would be caught by exact compare', () => {
    const ctx = newContext()
    const rows: Json = [{ id: 1 }, { id: 2 }]
    const normal = normalize(rows, { normalizers: [], ctx })
    // simulate a buggy normalizer output that silently dropped the second row
    const buggy: Json = [{ id: 1 }]
    expect(
      compare({ mode: 'exact', extraVendorFields: [], baseline: normal, candidate: buggy }).length,
    ).toBeGreaterThan(0)
  })
})

describe('compare (contract §19.2)', () => {
  it('exact finds a nested value mismatch with a path', () => {
    const diffs = compare({
      mode: 'exact',
      extraVendorFields: [],
      baseline: { a: { b: 1 } },
      candidate: { a: { b: 2 } },
    })
    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.path).toBe('/a/b')
  })

  it('unordered-multiset ignores order but not multiplicity', () => {
    expect(
      compare({
        mode: 'unordered-multiset',
        extraVendorFields: [],
        baseline: [1, 2, 2],
        candidate: [2, 1, 2],
      }),
    ).toHaveLength(0)
    expect(
      compare({
        mode: 'unordered-multiset',
        extraVendorFields: [],
        baseline: [1, 2, 2],
        candidate: [2, 1],
      }).length,
    ).toBeGreaterThan(0)
  })

  it('subset ignores only declared vendor-extra fields', () => {
    const diffs = compare({
      mode: 'subset',
      extraVendorFields: ['created_at'],
      baseline: { id: 1, created_at: 't' },
      candidate: { id: 1 },
    })
    expect(diffs).toHaveLength(0)
  })

  it('ordered-sequence keeps order significant', () => {
    expect(
      compare({
        mode: 'ordered-sequence',
        extraVendorFields: [],
        baseline: [1, 2],
        candidate: [2, 1],
      }).length,
    ).toBeGreaterThan(0)
  })
})

describe('classify (contract §19.2)', () => {
  const base = {
    scenario: 's',
    diffs: [{ path: '/x', expected: 1 as Json, actual: 2 as Json, note: 'v' }],
    secondaryVendorAgrees: true,
    registry: [] as never[],
  }

  it('a kernel diff with no rationale is a blocking kernel_regression', () => {
    const c = classify({ ...base, target: { id: 'supakernel.pg', nature: 'product' } })
    expect(c.class).toBe('kernel_regression')
    expect(c.blocking).toBe(true)
  })

  it('a black-box diff is a non-blocking supalite_divergence', () => {
    const c = classify({ ...base, target: { id: 'blackbox.supalite', nature: 'blackbox' } })
    expect(c.class).toBe('supalite_divergence')
    expect(c.blocking).toBe(false)
  })

  it('a target provisioning failure is environment_failure, never a pass', () => {
    const c = classify({
      ...base,
      target: { id: 'vendor.supabase-local', nature: 'vendor' },
      targetFailure: 'down',
    })
    expect(c.class).toBe('environment_failure')
    expect(c.blocking).toBe(false)
  })

  it('a registered rationale downgrades a kernel diff to intentional_divergence', () => {
    const c = classify({
      scenario: 'auth.wrong-password-error',
      target: { id: 'supakernel.pg', nature: 'product' },
      diffs: [{ path: '/error/legacy', expected: null, actual: 'x', note: 'v' }],
      secondaryVendorAgrees: true,
      registry: DIVERGENCE_REGISTRY,
    })
    expect(c.class).toBe('intentional_divergence')
    expect(c.blocking).toBe(false)
  })
})

describe('scenario schema (contract §8)', () => {
  it('every shipped scenario is valid', () => {
    for (const s of ALL_SCENARIOS) expect(validateScenario(s), s.id).toEqual([])
  })
  it('rejects an unknown operation action', () => {
    const issues = validateScenario({
      schemaVersion: 1,
      id: 'x',
      capability: 'data',
      requires: [],
      setup: [],
      operations: [{ id: 'o', action: 'data.frobnicate', input: {} }],
      observe: [],
      compare: { mode: 'exact' },
      normalization: [],
      seed: '00000000000000000000000000000000',
    })
    expect(issues.some((i) => i.path.includes('operations[0].action'))).toBe(true)
  })
})

describe('reducer signature (contract §19.2)', () => {
  it('preserves the blocking failure fingerprint across identical inputs', () => {
    const rows = [
      {
        target: 'supakernel.pg',
        classification: {
          class: 'kernel_regression' as const,
          blocking: true,
          diffs: [{ path: '/a', expected: 1 as Json, actual: 2 as Json, note: 'v' }],
          matchedRegistryIds: [],
          note: '',
        },
      },
    ]
    expect(diffSignature(rows)).toBe(diffSignature([...rows]))
  })
})
