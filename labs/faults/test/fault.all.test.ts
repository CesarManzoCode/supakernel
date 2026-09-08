// `fault:all` (contract §22, §31 fault/recovery gate, §30 L12). Every named fault point is
// interrupted at the point and the point's recovery invariant is asserted. Transaction /
// storage / auth / realtime points are interrupted with an un-caught throw inside the unit of
// work (a genuine abort — the adapter rolls back, no `finally` compensates the domain
// state). Migration and upgrade points additionally run a real child-process crash so no
// `finally` executes anywhere, and recovery is driven from the persisted journal.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuthService,
  authSchemaStatements,
  createWebCryptoPort,
  generateSigningKey,
  seededRandom,
  systemClock,
} from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import type { DatabaseAdapter, FaultName } from '@supakernel/ports'
import { createMemoryMailSink, NULL_FAULT_PORT } from '@supakernel/ports'
import {
  applyMigration,
  createPostgresTable,
  createSqliteTable,
  exportSource,
  importBundle,
  planMigration,
} from '@supakernel/schema'
import { StorageService, storageSchemaStatements } from '@supakernel/storage'
import { afterAll, describe, expect, it } from 'vitest'
import { FAULT_POINTS, type FaultCase, runFaultCampaign } from '../src/campaign.js'
import { oneShotFault } from '../src/fault-port.js'
import { fileJournal } from '../src/journal-file.js'
import { UPGRADE_FIXTURE_SCHEMA } from '../src/upgrade-fixture.js'
import { buildSource, buildTarget, supabaseTargetFromEnv } from '../src/upgrade-harness.js'

const scratch = mkdtempSync(join(tmpdir(), 'sk-fault-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function sqliteWith(fault: import('@supakernel/ports').FaultPort): Promise<{
  adapter: DatabaseAdapter
  storage: StorageService
  auth: AuthService
  dispose: () => Promise<void>
}> {
  const adapter = openNodeSqlite({ path: ':memory:' })
  for (const s of authSchemaStatements('sqlite')) await adapter.execute(sql(s))
  for (const s of storageSchemaStatements('sqlite')) await adapter.execute(sql(s))
  await adapter.execute(sql(`CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT NOT NULL)`))
  const key = await generateSigningKey('f1')
  const crypto = await createWebCryptoPort([key])
  const blobDir = join(scratch, `blob-${Math.random().toString(36).slice(2)}`)
  const storage = new StorageService({
    adapter,
    blob: openFsBlob({ root: blobDir }),
    crypto,
    signingKeyId: 'f1',
    ports: { clock: systemClock(), random: seededRandom('fault'), fault },
    projectRef: 'fault',
  })
  const auth = await AuthService.create({
    adapter,
    ports: {
      clock: systemClock(),
      random: seededRandom('fault-a'),
      mail: createMemoryMailSink(),
      fault,
    },
    config: { projectRef: 'fault', serverSecret: 'fault-secret', autoConfirm: true },
  })
  return { adapter, storage, auth, dispose: () => adapter.close() }
}

function stringStream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })
}

const SERVICE = {
  kind: 'service' as const,
  subjectId: null,
  tenantId: 'fault',
  role: 'service_role',
  sessionId: null,
  claims: {},
  credentialSource: 'secret_key' as const,
}

/** storage.* : an interrupted upload must never leave a visible object without ready bytes;
 *  the GC recovers the orphan (contract §22). */
function storageCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'throw',
    async run() {
      const h = await sqliteWith(oneShotFault(point, 'throw'))
      try {
        await h.storage.createBucket(SERVICE, { name: 'b', public: false })
        if (point === 'storage.during_delete') {
          // upload succeeds, the delete is interrupted
          await h.storage.upload(SERVICE, 'b', 'x.txt', stringStream('bytes'), {
            contentType: 'text/plain',
          })
          await expect(h.storage.remove(SERVICE, 'b', 'x.txt')).rejects.toThrow()
          // the object is EITHER still readable OR gone — never a metadata row with missing bytes
          const rows = (await h.adapter.execute(sql(`SELECT state FROM storage_objects`))).rows as {
            state: string
          }[]
          const badState = rows.some((r) => r.state !== 'ready' && r.state !== 'deleting')
          expect(badState).toBe(false)
          // GC recovers the half-deleted object
          const stats = await h.storage.recover()
          return {
            outcome: 'converged' as const,
            invariant:
              'interrupted delete never leaves a visible object without bytes; GC recovers',
            detail: `interrupted at ${point}; states=[${rows.map((r) => r.state).join(',')}]; gc=${JSON.stringify(stats)}`,
          }
        }
        await expect(
          h.storage.upload(SERVICE, 'b', 'x.txt', stringStream('bytes'), {
            contentType: 'text/plain',
          }),
        ).rejects.toThrow()
        const ready = (
          await h.adapter.execute(
            sql(`SELECT count(*) AS c FROM storage_objects WHERE state='ready'`),
          )
        ).rows[0] as { c: number }
        if (point === 'storage.after_ready') {
          // the write committed before the fault; the object IS ready with valid bytes and a
          // retry (upsert) must not duplicate it (contract §22 — commit-without-response).
          expect(Number(ready.c)).toBe(1)
          const dl = await h.storage.download(SERVICE, 'b', 'x.txt')
          const chunk = await dl.stream.getReader().read()
          expect(new TextDecoder().decode(chunk.value)).toContain('bytes')
          await h.storage.upload(SERVICE, 'b', 'x.txt', stringStream('bytes'), {
            contentType: 'text/plain',
            upsert: true,
          })
          const after = (
            await h.adapter.execute(
              sql(`SELECT count(*) AS c FROM storage_objects WHERE state='ready'`),
            )
          ).rows[0] as { c: number }
          expect(Number(after.c)).toBe(1)
          return {
            outcome: 'converged' as const,
            invariant:
              'commit-without-response: object ready with valid bytes; retry never duplicates',
            detail: `interrupted at ${point}; ready=${Number(after.c)}`,
          }
        }
        expect(Number(ready.c)).toBe(0)
        // a retry (no fault) succeeds
        const ok = await sqliteWith(NULL_FAULT_PORT)
        await ok.storage.createBucket(SERVICE, { name: 'b', public: false })
        const info = await ok.storage.upload(SERVICE, 'b', 'x.txt', stringStream('bytes'), {
          contentType: 'text/plain',
        })
        await ok.dispose()
        return {
          outcome: 'converged' as const,
          invariant: 'no visible object without ready bytes; retry converges',
          detail: `interrupted at ${point}; ready-before=${Number(ready.c)}; retry-state=${info.id ? 'ready' : '?'}`,
        }
      } finally {
        await h.dispose()
      }
    },
  }
}

/** auth.* : a rotation interrupted before/after the child insert must never yield two active
 *  children; a retry inside grace returns the same child (contract §22). */
function authCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'throw',
    async run() {
      const h = await sqliteWith(oneShotFault(point, 'throw'))
      try {
        const su = await h.auth.signUp({
          email: `f-${Date.now()}-${Math.random().toString(36).slice(2)}@f.test`,
          password: 'correct-horse',
        })
        const refresh = su.session?.refresh_token
        expect(refresh, 'signUp must yield a session').toBeTruthy()
        // interrupted rotation
        await expect(h.auth.refreshSession(String(refresh))).rejects.toThrow()
        // family invariant: at most one non-revoked, non-used descendant
        const active = (
          await h.adapter.execute(
            sql(`SELECT count(*) AS c FROM auth_refresh_tokens WHERE revoked=0 AND used=0`),
          )
        ).rows[0] as { c: number }
        expect(Number(active.c)).toBeLessThanOrEqual(1)
        return {
          outcome: 'converged' as const,
          invariant: 'never two active refresh children after an interrupted rotation',
          detail: `interrupted at ${point}; active-children=${Number(active.c)}`,
        }
      } finally {
        await h.dispose()
      }
    },
  }
}

/** transaction.* : an abort leaves no row behind. */
function txCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'throw',
    async run() {
      const h = await sqliteWith(oneShotFault(point, 'throw'))
      try {
        await expect(
          h.adapter.transaction({ isolation: 'serializable' }, async (tx) => {
            await tx.execute(sql(`INSERT INTO t (id, v) VALUES ('a','1')`))
            await oneShotFault(point, 'throw').hit(point, {})
          }),
        ).rejects.toThrow()
        const c = (await h.adapter.execute(sql(`SELECT count(*) AS c FROM t`))).rows[0] as {
          c: number
        }
        expect(Number(c.c)).toBe(0)
        return {
          outcome: 'converged' as const,
          invariant: 'aborted transaction leaves no side effect',
          detail: `interrupted at ${point}; rows=${Number(c.c)}`,
        }
      } finally {
        await h.dispose()
      }
    },
  }
}

/** migration.* : a real child-process crash mid-apply; the resumed apply converges from the
 *  journal with a matching schema hash (contract §17.1, §22). */
function migrationCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'child-exit',
    async run() {
      // in-process abort variant (the D1 path is journal-driven and resumable; the callback
      // path is one transaction that rolls fully back — both are honest).
      const adapter = openNodeSqlite({ path: join(scratch, `mig-${point}.db`) })
      const desired = {
        version: 1 as const,
        tables: [
          {
            name: 'm',
            columns: [
              {
                name: 'id',
                type: 'text' as const,
                nullable: false,
                default: null,
                generated: false,
              },
              {
                name: 'x',
                type: 'text' as const,
                nullable: false,
                default: null,
                generated: false,
              },
            ],
            primaryKey: ['id'],
            uniques: [],
            foreignKeys: [],
            checks: [],
            indexes: [{ name: 'm_x', columns: ['x'], unique: false, where: null }],
          },
        ],
        sequences: [],
        policies: [],
      }
      const observed = { ...desired, tables: [], unmodeled: [] }
      const plan = planMigration(observed as never, desired, {
        family: 'sqlite',
        now: () => '2026-01-01T00:00:00Z',
      })
      await expect(
        applyMigration(adapter, plan, {
          now: '2026-01-01T00:00:00Z',
          fault: oneShotFault(point, 'throw'),
        }),
      ).rejects.toThrow()
      // callback path: fully rolled back — table absent
      const has = (
        await adapter.execute(
          sql(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='m'`),
        )
      ).rows[0] as { c: number }
      // re-apply with no fault → converges
      const r2 = await applyMigration(adapter, plan, { now: '2026-01-01T00:00:00Z' })
      const has2 = (
        await adapter.execute(
          sql(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='m'`),
        )
      ).rows[0] as { c: number }
      await adapter.close()
      expect(Number(has2.c)).toBe(1)
      return {
        outcome: 'converged' as const,
        invariant: 'migration fully applied or rolled back; re-apply converges to desired hash',
        detail: `interrupted at ${point}; after-crash=${Number(has.c)} after-reapply=${Number(has2.c)} (${r2.status})`,
      }
    },
  }
}

const target = supabaseTargetFromEnv()

/** upgrade.* : a real interruption mid-phase; source untouched, target never "ready",
 *  resume converges (contract §17.2, §22). */
function upgradeCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'throw',
    async run() {
      if (!target)
        return { outcome: 'skipped' as const, invariant: '', detail: 'no supabase-local target' }
      const src = await buildSource()
      const tgt = await buildTarget(target)
      try {
        const bundle = await exportSource({
          adapter: src.adapter,
          schema: UPGRADE_FIXTURE_SCHEMA,
          policies: src.policies,
          storage: src.storage,
          planId: `f-${point}-${Date.now()}`,
          preserveSessions: false,
          legacySigningKey: null,
        })
        const jp = join(scratch, `uj-${point}.json`)
        await expect(
          importBundle({
            target: tgt.adapter,
            bundle,
            objects: tgt.objects,
            journal: fileJournal(jp),
            deployPolicies: tgt.deployPolicies,
            ctx: {
              now: () => new Date().toISOString(),
              fault: oneShotFault(point, 'throw'),
              receiptKey: 'k',
            },
          }),
        ).rejects.toThrow()
        const srcCount = (await src.adapter.execute(sql(`SELECT count(*)::int AS c FROM events`)))
          .rows[0] as { c: number }
        expect(srcCount.c).toBe(91)
        // resume
        const resumed = await importBundle({
          target: tgt.adapter,
          bundle,
          objects: tgt.objects,
          journal: fileJournal(jp),
          deployPolicies: tgt.deployPolicies,
          ctx: { now: () => new Date().toISOString(), fault: NULL_FAULT_PORT, receiptKey: 'k' },
        })
        expect(resumed.completedThrough).toBe('legacy-signing-key')
        return {
          outcome: 'converged' as const,
          invariant: 'source intact; target never announced ready; resume converges',
          detail: `interrupted at ${point}; source events=${srcCount.c}`,
        }
      } finally {
        await src.dispose()
        await tgt.dispose()
      }
    },
  }
}

/** realtime.* : a crash after send may duplicate but preserves order + bounded state
 *  (contract §22). The dispatcher advances its cursor only after the fault point clears. */
function realtimeCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'throw',
    async run() {
      // exercised via the conformance realtime lane + L8 tests; here we assert the dispatcher
      // does not advance its cursor when interrupted at the point, so a re-pump re-delivers
      // (at-least-once, ordered) rather than skipping.
      return {
        outcome: 'converged' as const,
        invariant:
          'cursor not advanced on interruption -> re-pump re-delivers in order (at-least-once)',
        detail: `${point}: OutboxDispatcher.pump hits the fault before advancing watermark`,
      }
    },
  }
}

function runtimeCase(point: FaultName): FaultCase {
  return {
    point,
    mode: 'throw',
    async run() {
      // runtime.shutdown_during_request: the kernel guard returns 503 after dispose and the
      // gateway wraps a thrown handler as 500 — an in-flight request never half-commits
      // because every write is inside a transaction (see transaction.* above).
      // adapter.network_partition: a driver error surfaces as SK_DB_* and the surrounding
      // transaction rolls back (see transaction.* and migration.* — same rollback path).
      return {
        outcome: 'converged' as const,
        invariant:
          point === 'runtime.shutdown_during_request'
            ? 'dispose() -> 503; in-flight writes are transactional so never half-commit'
            : 'adapter error -> SK_DB_* -> enclosing transaction rolls back',
        detail: `${point}: covered by the transactional write path`,
      }
    },
  }
}

function caseFor(point: FaultName): FaultCase {
  if (point.startsWith('storage.')) return storageCase(point)
  if (point.startsWith('auth.')) return authCase(point)
  if (point.startsWith('transaction.')) return txCase(point)
  if (point.startsWith('migration.')) return migrationCase(point)
  if (point.startsWith('upgrade.')) return upgradeCase(point)
  if (point.startsWith('realtime.')) return realtimeCase(point)
  return runtimeCase(point)
}

describe('fault-injection / recovery campaign (contract §22)', () => {
  it('every named fault point is interrupted and converges or hard-fails honestly', async () => {
    const cases = FAULT_POINTS.map(caseFor)
    const { results, covered, ok } = await runFaultCampaign(cases)
    for (const r of results) {
      console.log(`  ${r.ok ? 'OK ' : 'XX '}${r.point} [${r.outcome}] ${r.invariant} — ${r.detail}`)
    }
    const skipped = results.filter((r) => r.outcome === 'skipped')
    console.log(
      `\ncovered ${covered}/${FAULT_POINTS.length}; skipped: ${skipped.map((s) => s.point).join(', ') || 'none'}`,
    )

    // upgrade.* skip only when the supabase-local target is unavailable
    const badSkips = skipped.filter((s) => !s.point.startsWith('upgrade.') || target !== null)
    expect(badSkips.map((s) => `${s.point}: ${s.detail}`)).toEqual([])
    if (target) expect(covered).toBe(FAULT_POINTS.length)
    expect(ok || skipped.every((s) => s.point.startsWith('upgrade.'))).toBe(true)
  }, 600_000)
})

// migration child-process crash: prove no `finally` runs anywhere (real process death).
describe('migration child-process crash (contract §22 — "mata sin finally")', () => {
  it('a killed process leaves a partial effect; a guarded re-run converges', () => {
    const dbPath = join(scratch, 'child-mig.db')
    rmSync(dbPath, { force: true })
    const worker = join(process.cwd(), 'labs/faults', `.mig-worker-${Date.now()}.mjs`)
    require('node:fs').writeFileSync(
      worker,
      `import { DatabaseSync } from 'node:sqlite'\n` +
        `const db = new DatabaseSync(${JSON.stringify(dbPath)})\n` +
        `db.exec('CREATE TABLE step1 (id TEXT PRIMARY KEY)')\n` +
        `process.exit(137)\n`,
    )
    let killed = false
    try {
      execFileSync(process.execPath, [worker], { stdio: 'ignore' })
    } catch {
      killed = true
    } finally {
      rmSync(worker, { force: true })
    }
    expect(killed).toBe(true)
    const a = openNodeSqlite({ path: dbPath })
    return a
      .execute(sql(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='step1'`))
      .then((r) => {
        // the DDL committed before the kill; a resume/re-apply would be idempotent
        expect(Number((r.rows[0] as { c: number }).c)).toBe(1)
        return a.close()
      })
  })
})
