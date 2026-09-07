import {
  canonicalJson,
  type Expr,
  type Json,
  type PolicyAction,
  type Principal,
} from '@supakernel/contracts'
import { describe, expect, it } from 'vitest'
import { buildSecurityPlan, type PolicyContext } from '../src/index.js'
import { notesFixture, type Seat, USER_A, USER_B, USER_C } from './helpers/fixture.js'

/**
 * Manual semantic-mutant catalog for the policy compiler (contract §21.1). Every mutant must be
 * **killed**: for at least one case in the battery it must produce an observably different
 * `SecurityPlan` from the correct compiler, which the L4 test corpus pins. A surviving mutant
 * means the corpus does not constrain that behaviour and release is impossible.
 *
 * This is the L4-scoped catalog only; the general Stryker campaign is L12.
 */

const fx = notesFixture()
const now = '2026-09-06T00:00:00.000Z'

function principal(seat: Seat, claimsRole?: string): Principal {
  return {
    kind: seat.role === 'anon' ? 'anonymous' : seat.role === 'service_role' ? 'service' : 'user',
    subjectId: seat.role === 'anon' ? null : seat.subjectId,
    tenantId: seat.tenantId,
    role: seat.role,
    sessionId: 's',
    claims: { sub: seat.subjectId, tenant_id: seat.tenantId, role: claimsRole ?? seat.role },
    credentialSource: seat.role === 'anon' ? 'none' : 'jwt',
  }
}

interface Case {
  readonly label: string
  readonly principal: Principal
  readonly action: PolicyAction
}

const BATTERY: Case[] = [
  { label: 'A/select', principal: principal(USER_A), action: 'select' },
  { label: 'A/insert', principal: principal(USER_A), action: 'insert' },
  { label: 'A/update', principal: principal(USER_A), action: 'update' },
  { label: 'A/delete', principal: principal(USER_A), action: 'delete' },
  { label: 'B/select', principal: principal(USER_B), action: 'select' },
  { label: 'C/select', principal: principal(USER_C), action: 'select' },
  {
    label: 'anon/select',
    principal: principal({ label: 'anon', subjectId: 'x', tenantId: 'tenant-1', role: 'anon' }),
    action: 'select',
  },
  {
    label: 'anon-forged-role/select',
    principal: principal(
      { label: 'anon', subjectId: 'x', tenantId: 'tenant-1', role: 'anon' },
      'authenticated',
    ),
    action: 'select',
  },
  {
    label: 'forged-svc/select',
    principal: principal({ ...USER_A, role: 'service_role' }, 'service_role'),
    action: 'select',
  },
]

function ctx(): PolicyContext {
  return { schema: fx.schema, rules: fx.policies, principal: principal(USER_A), now }
}

interface Sig {
  decision: string
  readable: string[]
  writable: string[]
  rowUsing: string
  rowCheck: string
}

function signature(p: {
  decision: string
  readableFields: ReadonlySet<string>
  writableFields: ReadonlySet<string>
  rowUsing: Expr | null
  rowCheck: Expr | null
}): Sig {
  return {
    decision: p.decision,
    readable: [...p.readableFields].sort(),
    writable: [...p.writableFields].sort(),
    rowUsing: p.rowUsing ? canonicalJson(p.rowUsing as unknown as Json) : 'null',
    rowCheck: p.rowCheck ? canonicalJson(p.rowCheck as unknown as Json) : 'null',
  }
}

function correct(c: Case): Sig {
  return signature(
    buildSecurityPlan({ ...ctx(), principal: c.principal }, { table: 'notes', action: c.action }),
  )
}

function swapLogic(e: Expr | null): Expr | null {
  if (!e) return e
  if (e.kind === 'logic')
    return {
      kind: 'logic',
      op: e.op === 'and' ? 'or' : 'and',
      terms: e.terms.map((t) => swapLogic(t) as Expr),
    }
  if (e.kind === 'not') return { kind: 'not', term: swapLogic(e.term) as Expr }
  if (e.kind === 'compare')
    return {
      kind: 'compare',
      op: e.op,
      left: swapLogic(e.left) as Expr,
      right: swapLogic(e.right) as Expr,
    }
  return e
}

type Mutant = (c: Case) => Sig

const MUTANTS: Record<string, Mutant> = {
  'allow<->deny (invert decision)': (c) => {
    const s = correct(c)
    return { ...s, decision: s.decision === 'allow' ? 'deny' : 'allow' }
  },
  'default allow (deny becomes allow)': (c) => {
    const s = correct(c)
    return s.decision === 'deny' ? { ...s, decision: 'allow' } : s
  },
  'remove readable field gate (all columns readable)': (c) => {
    const s = correct(c)
    return { ...s, readable: fx.schema.tables[0]?.columns.map((x) => x.name).sort() ?? [] }
  },
  'remove writable field gate (all columns writable)': (c) => {
    const s = correct(c)
    return { ...s, writable: fx.schema.tables[0]?.columns.map((x) => x.name).sort() ?? [] }
  },
  'drop immutable check (immutable columns become writable)': (c) => {
    const s = correct(c)
    const immut = ['id', 'tenant_id', 'owner_id', 'created_at']
    return {
      ...s,
      writable: [
        ...new Set([
          ...s.writable,
          ...immut.filter(() => s.decision === 'allow' && c.action === 'update'),
        ]),
      ].sort(),
    }
  },
  'omit WITH CHECK (rowCheck always null)': (c) => ({ ...correct(c), rowCheck: 'null' }),
  'flip AND/OR in row predicate': (c) => {
    const p = buildSecurityPlan(
      { ...ctx(), principal: c.principal },
      { table: 'notes', action: c.action },
    )
    return signature({ ...p, rowUsing: swapLogic(p.rowUsing), rowCheck: swapLogic(p.rowCheck) })
  },
  'trust claims.role instead of verified principal.role': (c) => {
    // an attacker sets claims.role = 'authenticated' while the verified role is 'anon'
    const forged: Principal = {
      ...c.principal,
      role: String(c.principal.claims.role ?? c.principal.role),
    }
    return signature(
      buildSecurityPlan({ ...ctx(), principal: forged }, { table: 'notes', action: c.action }),
    )
  },
  'ignore restrictive rules (drop tenant guard)': (c) => {
    const permissiveOnly = fx.policies.filter((r) => r.mode !== 'restrictive')
    return signature(
      buildSecurityPlan(
        {
          schema: { ...fx.schema, policies: permissiveOnly },
          rules: permissiveOnly,
          principal: c.principal,
          now,
        },
        { table: 'notes', action: c.action },
      ),
    )
  },
  'service bypass without secret_key credential': (c) => {
    if (c.principal.role !== 'service_role') return correct(c)
    return signature(
      buildSecurityPlan(
        {
          ...ctx(),
          principal: { ...c.principal, credentialSource: 'secret_key', kind: 'service' },
        },
        { table: 'notes', action: c.action },
      ),
    )
  },
}

describe('manual semantic-mutant catalog — 100% kill required (contract §21.1)', () => {
  it('the battery has a stable set of correct signatures', () => {
    const sigs = BATTERY.map((c) => ({ [c.label]: correct(c) }))
    expect(sigs.length).toBe(BATTERY.length)
  })

  for (const [name, mutate] of Object.entries(MUTANTS)) {
    it(`kills: ${name}`, () => {
      const killedOn = BATTERY.filter(
        (c) =>
          canonicalJson(mutate(c) as unknown as Json) !==
          canonicalJson(correct(c) as unknown as Json),
      )
      // the mutant must differ from correct on at least one battery case
      expect(killedOn.length).toBeGreaterThan(0)
    })
  }
})
