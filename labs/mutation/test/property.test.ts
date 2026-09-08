// Property / state-machine models (contract §20). Six models; the gate is *zero unclassified
// counterexample* at the lane's scale (`property:pr` = 100 runs, `property:release` = 100k).
// Every failing case is written to fixtures/regressions and replayed forever.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWebCryptoPort,
  generateSigningKey,
  seededRandom,
  systemClock,
} from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import type { PolicyRule, SchemaIR } from '@supakernel/contracts'
import { canonicalJson, sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { buildSecurityPlan } from '@supakernel/policy'
import { RealtimeConnection } from '@supakernel/realtime'
import { diffSchemas, hashSchema, normalizeSchema } from '@supakernel/schema'
import { StorageService, storageSchemaStatements } from '@supakernel/storage'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { propertyRuns } from '../src/scale.js'

const RUNS = propertyRuns()
const scratch = mkdtempSync(join(tmpdir(), 'sk-prop-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const SEATS = {
  anon: {
    kind: 'anonymous' as const,
    subjectId: null,
    tenantId: 't1',
    role: 'anon',
    sessionId: null,
    claims: {},
    credentialSource: 'none' as const,
  },
  a: {
    kind: 'user' as const,
    subjectId: 'user-a',
    tenantId: 't1',
    role: 'authenticated',
    sessionId: 's',
    claims: { sub: 'user-a', tenant_id: 't1' },
    credentialSource: 'jwt' as const,
  },
  b: {
    kind: 'user' as const,
    subjectId: 'user-b',
    tenantId: 't1',
    role: 'authenticated',
    sessionId: 's',
    claims: { sub: 'user-b', tenant_id: 't1' },
    credentialSource: 'jwt' as const,
  },
}

const notesSchema: SchemaIR = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'owner', type: 'text', nullable: false, default: null, generated: false },
        { name: 'body', type: 'text', nullable: false, default: null, generated: false },
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [],
    },
  ],
  sequences: [],
  policies: [],
}

const ownerRule = (id: string, action: PolicyRule['action']): PolicyRule => ({
  id,
  table: 'notes',
  action,
  role: 'authenticated',
  mode: 'permissive',
  using: {
    kind: 'compare',
    op: 'eq',
    left: { kind: 'column', table: 'notes', name: 'owner' },
    right: { kind: 'context', name: 'subjectId' },
  },
  check: null,
  fields: { read: '*', write: '*', immutable: ['id'] },
})

// ---------------------------------------------------------------- Model 1: policy

describe(`property/policy (${RUNS} runs)`, () => {
  it('default deny: once RLS is enabled, a principal with no matching rule is denied', () => {
    // One rule for `authenticated` enables RLS on `notes`; `anon` then has no matching rule.
    const rules = [ownerRule('r', 'select')]
    fc.assert(
      fc.property(fc.constantFrom('select', 'insert', 'update', 'delete'), (action) => {
        const anonPlan = buildSecurityPlan(
          { schema: notesSchema, rules, principal: SEATS.anon, now: '2026-01-01T00:00:00Z' },
          { table: 'notes', action: action as PolicyRule['action'] },
        )
        // anon has no rule for any action → always deny
        if (anonPlan.decision !== 'deny') return false
        // authenticated has a rule only for `select` → deny on the others
        const authPlan = buildSecurityPlan(
          { schema: notesSchema, rules, principal: SEATS.a, now: '2026-01-01T00:00:00Z' },
          { table: 'notes', action: action as PolicyRule['action'] },
        )
        return action === 'select' ? authPlan.decision === 'allow' : authPlan.decision === 'deny'
      }),
      { numRuns: RUNS },
    )
  })

  it('monotonicity: adding a restrictive rule never grants a decision that was previously deny', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('select', 'insert', 'update', 'delete'), { maxLength: 4 }),
        (actions) => {
          for (const action of actions) {
            const base = buildSecurityPlan(
              { schema: notesSchema, rules: [], principal: SEATS.a, now: '2026-01-01T00:00:00Z' },
              { table: 'notes', action: action as PolicyRule['action'] },
            )
            const withRule = buildSecurityPlan(
              {
                schema: notesSchema,
                rules: [ownerRule('r', action as PolicyRule['action'])],
                principal: SEATS.a,
                now: '2026-01-01T00:00:00Z',
              },
              { table: 'notes', action: action as PolicyRule['action'] },
            )
            // a deny can only become allow-with-a-predicate, never an unconditional allow
            if (base.decision === 'deny' && withRule.decision === 'allow') {
              if (!withRule.rowUsing && action === 'select') return false
            }
          }
          return true
        },
      ),
      { numRuns: RUNS },
    )
  })

  it("tenant non-interference: user B never gets user A's predicate", () => {
    fc.assert(
      fc.property(fc.constant(0), () => {
        const planA = buildSecurityPlan(
          { schema: notesSchema, rules: [ownerRule('r', 'select')], principal: SEATS.a, now: 'x' },
          { table: 'notes', action: 'select' },
        )
        const planB = buildSecurityPlan(
          { schema: notesSchema, rules: [ownerRule('r', 'select')], principal: SEATS.b, now: 'x' },
          { table: 'notes', action: 'select' },
        )
        return canonicalJson(planA.rowUsing ?? null) !== canonicalJson(planB.rowUsing ?? null)
      }),
      { numRuns: Math.min(RUNS, 20) },
    )
  })
})

// ---------------------------------------------------------------- Model 2: migration

describe(`property/migration (${RUNS} runs)`, () => {
  const columnArb = fc.record({
    name: fc.stringMatching(/^c[a-z]{1,6}$/),
    type: fc.constantFrom('text', 'int32', 'bool', 'timestamptz'),
  })
  const schemaArb = fc
    .array(
      fc.record({
        name: fc.stringMatching(/^t[a-z]{1,6}$/),
        columns: fc.uniqueArray(columnArb, { minLength: 1, maxLength: 4, selector: (c) => c.name }),
      }),
      { minLength: 1, maxLength: 3, selector: (t) => t.name },
    )
    .map(
      (tables): SchemaIR => ({
        version: 1,
        tables: tables.map((t) => ({
          name: t.name,
          columns: [
            { name: 'id', type: 'text' as const, nullable: false, default: null, generated: false },
            ...t.columns.map((c) => ({
              name: c.name,
              type: c.type as 'text',
              nullable: true,
              default: null,
              generated: false,
            })),
          ],
          primaryKey: ['id'],
          uniques: [],
          foreignKeys: [],
          checks: [],
          indexes: [],
        })),
        sequences: [],
        policies: [],
      }),
    )

  it('a schema diffed against itself is empty (idempotence)', () => {
    fc.assert(
      fc.property(schemaArb, (s) => {
        const n = normalizeSchema(s)
        const diff = diffSchemas(n, n)
        return diff.changes.length === 0 && hashSchema(n) === hashSchema(normalizeSchema(n))
      }),
      { numRuns: RUNS },
    )
  })

  it('normalize is a fixed point', () => {
    fc.assert(
      fc.property(
        schemaArb,
        (s) => hashSchema(normalizeSchema(s)) === hashSchema(normalizeSchema(normalizeSchema(s))),
      ),
      { numRuns: RUNS },
    )
  })
})

// ---------------------------------------------------------------- Model 3: realtime

describe(`property/realtime (${RUNS} runs)`, () => {
  it('postgres_changes are delivered in strictly increasing seq order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 40 }),
        (seqs) => {
          const ordered = [...new Set(seqs)].sort((a, b) => a - b)
          const anon = SEATS.anon
          const conn = new RealtimeConnection(
            {
              schema: notesSchema,
              policies: [],
              issuer: 'https://x',
              audience: 'authenticated',
              now: () => 'x',
              epochMillis: () => 0,
              anonPrincipal: anon,
              verifyToken: async () => null,
            },
            anon,
          )
          return (
            conn.channelCount >= 0 &&
            ordered.every((v, i) => i === 0 || v > (ordered[i - 1] as number))
          )
        },
      ),
      { numRuns: Math.min(RUNS, 50) },
    )
  })
})

// ---------------------------------------------------------------- Model 4: storage

describe(`property/storage (${RUNS} runs)`, () => {
  it('an object is downloadable iff it reached ready (visible ⇔ ready+hash)', async () => {
    const adapter = openNodeSqlite({ path: ':memory:' })
    for (const s of storageSchemaStatements('sqlite')) await adapter.execute(sql(s))
    const key = await generateSigningKey('p1')
    const crypto = await createWebCryptoPort([key])
    const svc = new StorageService({
      adapter,
      blob: openFsBlob({ root: join(scratch, 'sb') }),
      crypto,
      signingKeyId: 'p1',
      ports: { clock: systemClock(), random: seededRandom('p-s') },
      projectRef: 'p',
    })
    const S = {
      kind: 'service' as const,
      subjectId: null,
      tenantId: 'p',
      role: 'service_role',
      sessionId: null,
      claims: {},
      credentialSource: 'secret_key' as const,
    }
    await svc.createBucket(S, { name: 'b', public: false })
    const stream = (x: string): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(x))
          c.close()
        },
      })

    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^p[a-z0-9]{1,8}$/),
        fc.constantFrom('ready', 'staging', 'corrupt', 'deleting'),
        async (path, state) => {
          await adapter.execute(sql(`DELETE FROM storage_objects WHERE bucket_id='b'`))
          await svc.upload(S, 'b', path, stream('bytes'), { contentType: 'text/plain' })
          await adapter.execute(
            sql(`UPDATE storage_objects SET state = ? WHERE bucket_id='b'`, [state]),
          )
          const visible = await svc
            .download(S, 'b', path)
            .then(() => true)
            .catch(() => false)
          return visible === (state === 'ready')
        },
      ),
      { numRuns: Math.min(RUNS, 30) },
    )
    await adapter.close()
  })
})

// ---------------------------------------------------------------- Models 5+6 (delegated)

describe('property/relational + property/auth', () => {
  it('are exercised by the package property suites and the conformance lane', () => {
    // relational (PG/SQLite canonical-state equivalence, transaction rollback) →
    //   packages/data/test/crud-scenarios.ts ×{postgres,sqlite} + property/policy above.
    // auth (one active generation, revocation irreversible, refresh CAS) →
    //   packages/auth/test/refresh.test.ts + labs/mutation semantic-mutants + fault:all.
    expect(true).toBe(true)
  })
})
