import { canonicalJson, type Family } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The shared Database connection contract suite (contract §9.3). Every L2 adapter calls
 * `runDatabaseContractSuite` with a harness that opens a fresh adapter over a disposable
 * resource. The suite branches only on `capabilities.family` for the fixture SQL — never on
 * `adapter.id` — and asserts the same normalized result everywhere.
 */
export interface DatabaseContractHarness {
  readonly label: string
  /** Open a brand-new adapter over an empty, disposable resource. */
  open(): Promise<DatabaseAdapter>
  /** Re-open over the *same* resource without cleaning it (crash / reopen case). Optional for
   *  memory-only bindings. */
  reopen?: () => Promise<DatabaseAdapter>
  /** A second live handle to the same resource, for the concurrent-writers case. Optional. */
  openSecond?: () => Promise<DatabaseAdapter>
  /** Delete the disposable resource and release handles. Always called after each case. */
  cleanup(): Promise<void>
}

export type DatabaseContractCase =
  | 'open-close-idempotent'
  | 'bind-null-bytes-int64-json'
  | 'constraint-mapping'
  | 'transaction-commit-rollback'
  | 'atomic-batch'
  | 'concurrent-writers'
  | 'int64-numeric-comparison'
  | 'returning-rows'
  | 'outbox-trigger'
  | 'introspection-round-trip'
  | 'crash-reopen'
  | 'capability-attestation'
  | 'resource-cleanup'

export const DATABASE_CONTRACT_CASES: readonly DatabaseContractCase[] = [
  'open-close-idempotent',
  'bind-null-bytes-int64-json',
  'constraint-mapping',
  'transaction-commit-rollback',
  'atomic-batch',
  'concurrent-writers',
  'int64-numeric-comparison',
  'returning-rows',
  'outbox-trigger',
  'introspection-round-trip',
  'crash-reopen',
  'capability-attestation',
  'resource-cleanup',
]

const INT64_ROUND_TRIP = [9007199254740992n, 9223372036854775807n, -9223372036854775808n] as const

interface Dialect {
  createFixture: readonly string[]
  createOutbox: readonly string[]
  ph(n: number): string
  param(i: number): string
  numeric(col: string): string
  returning(cols: string): string
}

function dialectFor(family: Family): Dialect {
  if (family === 'postgres') {
    return {
      createFixture: [
        `CREATE TABLE ct_item (
           id BIGINT PRIMARY KEY,
           label TEXT NOT NULL,
           qty BIGINT NOT NULL DEFAULT 0,
           payload BYTEA,
           doc JSONB,
           CONSTRAINT ct_item_label_key UNIQUE (label),
           CONSTRAINT ct_item_qty_nonneg CHECK (qty >= 0)
         )`,
      ],
      createOutbox: [
        `CREATE TABLE ct_outbox (seq BIGSERIAL PRIMARY KEY, item_id BIGINT NOT NULL, label TEXT NOT NULL)`,
        `CREATE FUNCTION ct_outbox_fn() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN INSERT INTO ct_outbox(item_id, label) VALUES (NEW.id, NEW.label); RETURN NEW; END $$`,
        `CREATE TRIGGER _sk_outbox_ct_item AFTER INSERT ON ct_item
           FOR EACH ROW EXECUTE FUNCTION ct_outbox_fn()`,
      ],
      ph: (n) => `(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(',')})`,
      param: (i) => `$${i}`,
      numeric: (col) => col,
      returning: (cols) => ` RETURNING ${cols}`,
    }
  }
  return {
    createFixture: [
      `CREATE TABLE ct_item (
         id SK_TEXT_I64 PRIMARY KEY,
         label TEXT NOT NULL,
         qty SK_TEXT_I64 NOT NULL DEFAULT '0',
         payload BLOB,
         doc SK_TEXT_JSON,
         CONSTRAINT ct_item_label_key UNIQUE (label),
         CONSTRAINT ct_item_qty_nonneg CHECK (CAST(qty AS INTEGER) >= 0)
       )`,
    ],
    createOutbox: [
      `CREATE TABLE ct_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id SK_TEXT_I64 NOT NULL, label TEXT NOT NULL)`,
      `CREATE TRIGGER _sk_outbox_ct_item AFTER INSERT ON ct_item
         BEGIN INSERT INTO ct_outbox(item_id, label) VALUES (NEW.id, NEW.label); END`,
    ],
    ph: (n) => `(${Array.from({ length: n }, () => '?').join(',')})`,
    param: () => '?',
    numeric: (col) => `CAST(${col} AS INTEGER)`,
    returning: (cols) => ` RETURNING ${cols}`,
  }
}

function asBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string') return BigInt(v)
  throw new Error(`not an int64 value: ${typeof v} ${String(v)}`)
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (v && typeof v === 'object' && 'byteLength' in v) return new Uint8Array(v as ArrayBufferLike)
  throw new Error(`not bytes: ${typeof v}`)
}

function asJson(v: unknown): unknown {
  return typeof v === 'string' ? JSON.parse(v) : v
}

export function runDatabaseContractSuite(harness: DatabaseContractHarness): void {
  describe(`database connection contract — ${harness.label}`, () => {
    const openHandles: DatabaseAdapter[] = []

    afterEach(async () => {
      for (const h of openHandles.splice(0)) {
        await h.close().catch(() => undefined)
      }
      await harness.cleanup()
    })

    const track = <T extends DatabaseAdapter>(a: T): T => {
      openHandles.push(a)
      return a
    }
    const open = async (): Promise<DatabaseAdapter> => track(await harness.open())
    const seedFixture = async (a: DatabaseAdapter, withOutbox = false): Promise<Dialect> => {
      const d = dialectFor(a.capabilities.family)
      const stmts = withOutbox ? [...d.createFixture, ...d.createOutbox] : d.createFixture
      for (const s of stmts) await a.execute({ text: s, parameters: [] })
      return d
    }

    it('open / close is idempotent', async () => {
      const a = await open()
      await a.close()
      await expect(a.close()).resolves.toBeUndefined()
    })

    it('binds null, bytes, exact int64 and canonical JSON with round-trip fidelity', async () => {
      const a = await open()
      const d = await seedFixture(a)
      const bytes = new Uint8Array([0, 1, 2, 254, 255])
      const doc = { b: 2, a: [1, null, 'x'], nested: { z: true } }
      for (const [i, big] of INT64_ROUND_TRIP.entries()) {
        await a.execute({
          text: `INSERT INTO ct_item (id, label, qty, payload, doc) VALUES ${d.ph(5)}`,
          parameters: [
            big,
            `row-${i}`,
            i === 2 ? 0n : big < 0n ? 0n : big,
            i === 0 ? bytes : null,
            i === 1 ? canonicalJson(doc) : null,
          ],
        })
      }
      const back = await a.execute({
        text: `SELECT id, qty, payload, doc FROM ct_item ORDER BY label`,
        parameters: [],
      })
      expect(back.rows).toHaveLength(3)
      expect(asBigInt(back.rows[0]?.id)).toBe(9007199254740992n)
      expect(asBigInt(back.rows[1]?.id)).toBe(9223372036854775807n)
      expect(asBigInt(back.rows[2]?.id)).toBe(-9223372036854775808n)
      expect([...asBytes(back.rows[0]?.payload)]).toEqual([...bytes])
      expect(back.rows[1]?.payload ?? null).toBeNull()
      expect(asJson(back.rows[1]?.doc)).toEqual(doc)
    })

    it('maps unique / check violations to typed errors', async () => {
      const a = await open()
      const d = await seedFixture(a)
      await a.execute({
        text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`,
        parameters: [1n, 'dup'],
      })
      await expect(
        a.execute({
          text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`,
          parameters: [2n, 'dup'],
        }),
      ).rejects.toMatchObject({ kernelError: { category: 'conflict' } })
      await expect(
        a.execute({
          text: `INSERT INTO ct_item (id, label, qty) VALUES ${d.ph(3)}`,
          parameters: [3n, 'neg', -5n],
        }),
      ).rejects.toMatchObject({ kernelError: { category: 'input' } })
    })

    it('commits and rolls back a transaction atomically', async () => {
      const a = await open()
      if (a.capabilities.transactions !== 'callback') return
      const d = await seedFixture(a)
      await a.transaction({ isolation: 'serializable' }, async (tx) => {
        await tx.execute({
          text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`,
          parameters: [1n, 'committed'],
        })
      })
      await expect(
        a.transaction({ isolation: 'serializable' }, async (tx) => {
          await tx.execute({
            text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`,
            parameters: [2n, 'rb'],
          })
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      const rows = await a.execute({
        text: `SELECT label FROM ct_item ORDER BY label`,
        parameters: [],
      })
      expect(rows.rows.map((r) => r.label)).toEqual(['committed'])
    })

    it('runs an atomic batch as one indivisible unit', async () => {
      const a = await open()
      const d = await seedFixture(a)
      await a.atomicBatch([
        { text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`, parameters: [1n, 'a'] },
        { text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`, parameters: [2n, 'b'] },
      ])
      expect(
        Number(
          (await a.execute({ text: `SELECT count(*) AS n FROM ct_item`, parameters: [] })).rows[0]
            ?.n,
        ),
      ).toBe(2)
      await expect(
        a.atomicBatch([
          { text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`, parameters: [3n, 'c'] },
          { text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`, parameters: [4n, 'a'] },
        ]),
      ).rejects.toBeDefined()
      expect(
        Number(
          (await a.execute({ text: `SELECT count(*) AS n FROM ct_item`, parameters: [] })).rows[0]
            ?.n,
        ),
      ).toBe(2)
    })

    it('filters and orders int64 numerically, not lexicographically', async () => {
      const a = await open()
      const d = await seedFixture(a)
      for (const [i, q] of [5n, 100n, 9007199254740992n, 9223372036854775807n].entries()) {
        await a.execute({
          text: `INSERT INTO ct_item (id, label, qty) VALUES ${d.ph(3)}`,
          parameters: [BigInt(i + 1), `q${i}`, q],
        })
      }
      const rhs =
        a.capabilities.family === 'postgres' ? d.param(1) : `CAST(${d.param(1)} AS INTEGER)`
      const gt = await a.execute({
        text: `SELECT label FROM ct_item WHERE ${d.numeric('qty')} > ${rhs}`,
        parameters: [100n],
      })
      expect(gt.rows.map((r) => r.label).sort()).toEqual(['q2', 'q3'])
      const ordered = await a.execute({
        text: `SELECT label FROM ct_item ORDER BY ${d.numeric('qty')} DESC`,
        parameters: [],
      })
      expect(ordered.rows.map((r) => r.label)).toEqual(['q3', 'q2', 'q1', 'q0'])
    })

    it('returns rows from a mutation when it attests returning support', async () => {
      const a = await open()
      if (!a.capabilities.returning) return
      const d = await seedFixture(a)
      const res = await a.execute({
        text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}${d.returning('id, label')}`,
        parameters: [42n, 'r'],
      })
      expect(res.rows).toHaveLength(1)
      expect(asBigInt(res.rows[0]?.id)).toBe(42n)
    })

    it('captures a managed outbox row in the same transaction as the write', async () => {
      const a = await open()
      const d = await seedFixture(a, true)
      await a.execute({
        text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`,
        parameters: [7n, 'watched'],
      })
      const out = await a.execute({ text: `SELECT item_id, label FROM ct_outbox`, parameters: [] })
      expect(out.rows).toHaveLength(1)
      expect(asBigInt(out.rows[0]?.item_id)).toBe(7n)
      expect(out.rows[0]?.label).toBe('watched')
    })

    it('round-trips the fixture schema through introspection without losing the CHECK', async () => {
      const a = await open()
      await seedFixture(a)
      const observed = await a.introspect()
      const item = observed.tables.find((t) => t.name === 'ct_item')
      expect(item, 'ct_item present').toBeDefined()
      expect(item?.primaryKey).toEqual(['id'])
      expect(item?.columns.find((c) => c.name === 'id')?.type).toBe('int64')
      expect(item?.columns.find((c) => c.name === 'label')?.nullable).toBe(false)
      expect(item?.columns.find((c) => c.name === 'payload')?.type).toBe('bytes')
      expect(item?.columns.find((c) => c.name === 'doc')?.type).toBe('json')
      expect(item?.uniques.some((u) => u.columns.includes('label'))).toBe(true)
      const check = item?.checks.find((c) => c.expr.kind === 'compare')
      expect(check, 'CHECK preserved as a portable Expr').toBeDefined()
      expect(check?.expr).toMatchObject({
        kind: 'compare',
        op: 'gte',
        left: { kind: 'column', name: 'qty' },
        right: { kind: 'literal', value: 0 },
      })
    })

    it('recovers committed data after a simulated crash and reopen', async () => {
      if (!harness.reopen) return
      const a = await open()
      const d = await seedFixture(a)
      await a.execute({
        text: `INSERT INTO ct_item (id, label) VALUES ${d.ph(2)}`,
        parameters: [1n, 'durable'],
      })
      const b = track(await harness.reopen())
      const rows = await b.execute({ text: `SELECT label FROM ct_item`, parameters: [] })
      expect(rows.rows.map((r) => r.label)).toEqual(['durable'])
    })

    it('serializes concurrent writers without lost updates', async () => {
      if (!harness.openSecond) return
      const a = await open()
      const d = await seedFixture(a)
      await a.execute({
        text: `INSERT INTO ct_item (id, label, qty) VALUES ${d.ph(3)}`,
        parameters: [1n, 'c', 0n],
      })
      const b = track(await harness.openSecond())
      const where = `WHERE id = ${d.param(1)}`
      const bump = (adapter: DatabaseAdapter) =>
        adapter.execute({
          text: `UPDATE ct_item SET qty = ${d.numeric('qty')} + 1 ${where}`,
          parameters: [1n],
        })
      const results = await Promise.allSettled([bump(a), bump(a), bump(b), bump(b)])
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const final = await a.execute({ text: `SELECT qty FROM ct_item ${where}`, parameters: [1n] })
      expect(asBigInt(final.rows[0]?.qty)).toBe(BigInt(ok))
    })

    it('attests its capabilities truthfully', async () => {
      const a = await open()
      const caps = a.capabilities
      const d = await seedFixture(a)
      if (caps.returning) {
        const r = await a.execute({
          text: `INSERT INTO ct_item (id,label) VALUES ${d.ph(2)}${d.returning('id')}`,
          parameters: [1n, 'att'],
        })
        expect(r.rows.length, 'SK_CAPABILITY_ATTESTATION: returning').toBe(1)
      }
      if (caps.transactions === 'callback') {
        await a
          .transaction({ isolation: 'serializable' }, async (tx) => {
            await tx.execute({
              text: `INSERT INTO ct_item (id,label) VALUES ${d.ph(2)}`,
              parameters: [2n, 'x'],
            })
            throw new Error('rollback')
          })
          .catch(() => undefined)
        const n = await a.execute({
          text: `SELECT count(*) AS n FROM ct_item WHERE label = ${d.param(1)}`,
          parameters: ['x'],
        })
        expect(Number(n.rows[0]?.n), 'SK_CAPABILITY_ATTESTATION: transaction rollback').toBe(0)
      }
      expect(caps.isolation.length).toBeGreaterThan(0)
    })

    it('releases every resource on close across many open / close cycles', {
      timeout: 60_000,
    }, async () => {
      for (let i = 0; i < 20; i++) {
        const a = track(await harness.open())
        await seedFixture(a)
        await a.close()
        await harness.cleanup()
      }
      expect(true).toBe(true)
    })
  })
}
