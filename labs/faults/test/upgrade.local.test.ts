// `test:upgrade:local` (contract §17.2, §31 upgrade gate, §30 L12). SupaKernel (PGlite —
// real PG sequences) → Supabase-local PostgreSQL. Verifies the mandatory invariants and a
// crash-resumable run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from '@supakernel/contracts'
import { NULL_FAULT_PORT } from '@supakernel/ports'
import {
  buildReceipt,
  exportSource,
  importBundle,
  planUpgrade,
  resumeUpgrade,
  verifyReceipt,
  verifyUpgrade,
} from '@supakernel/schema'
import { afterAll, describe, expect, it } from 'vitest'
import { oneShotFault } from '../src/fault-port.js'
import { fileJournal } from '../src/journal-file.js'
import { fixtureManifest } from '../src/upgrade-fixture.js'
import { buildSource, buildTarget, supabaseTargetFromEnv } from '../src/upgrade-harness.js'

const target = supabaseTargetFromEnv()
const suite = target ? describe : describe.skip
const scratch = mkdtempSync(join(tmpdir(), 'sk-upgrade-'))
const RECEIPT_KEY = 'upgrade-receipt-secret'

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

suite('upgrade SupaKernel -> Supabase-local (contract §17.2)', () => {
  it('release fixture completes with every invariant satisfied and a signed receipt', async () => {
    const src = await buildSource()
    const tgt = await buildTarget(target as NonNullable<typeof target>)
    const started = new Date().toISOString()
    try {
      const plan = await planUpgrade({
        source: src.adapter,
        target: tgt.adapter,
        schema: (await import('../src/upgrade-fixture.js')).UPGRADE_FIXTURE_SCHEMA,
        policies: src.policies,
        storage: src.storage,
        now: () => new Date().toISOString(),
        planId: `upg-${Date.now()}`,
      })
      expect(plan.refusals, JSON.stringify(plan.refusals)).toEqual([])
      expect(plan.canProceed).toBe(true)

      const bundle = await exportSource({
        adapter: src.adapter,
        schema: plan.source
          ? (await import('../src/upgrade-fixture.js')).UPGRADE_FIXTURE_SCHEMA
          : (await import('../src/upgrade-fixture.js')).UPGRADE_FIXTURE_SCHEMA,
        policies: src.policies,
        storage: src.storage,
        planId: plan.id,
        preserveSessions: false,
        legacySigningKey: null,
      })
      expect(bundle.tableRows.events?.length).toBe(91)

      const journal = fileJournal(join(scratch, 'j-clean.json'))
      const imported = await importBundle({
        target: tgt.adapter,
        bundle,
        objects: tgt.objects,
        journal,
        deployPolicies: tgt.deployPolicies,
        ctx: {
          now: () => new Date().toISOString(),
          fault: NULL_FAULT_PORT,
          receiptKey: RECEIPT_KEY,
        },
      })
      expect(imported.completedThrough).toBe('legacy-signing-key')

      const verified = await verifyUpgrade({
        target: tgt.adapter,
        bundle,
        schema: bundle.schema,
        objects: tgt.objects,
        passwordLoginProbe: tgt.passwordLoginProbe,
        expectSessionsRevoked: true,
      })
      const failed = verified.invariants.filter((i) => !i.ok)
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
      expect(verified.ok).toBe(true)

      // the mandatory 91 -> 92 fixture
      const nextId = (await tgt.adapter.execute(sql(`SELECT nextval('events_id_seq')::text AS n`)))
        .rows[0] as { n: string }
      expect(nextId.n).toBe('92')
      await tgt.adapter.execute(sql(`SELECT setval('events_id_seq', 91, true)`))

      const receipt = buildReceipt({
        planId: plan.id,
        startedAt: started,
        finishedAt: new Date().toISOString(),
        source: bundle.source,
        target: verified.targetFingerprint,
        journal: imported.journal,
        invariants: verified.invariants,
        sessionsRevoked: verified.sessionsRevoked,
        receiptKey: RECEIPT_KEY,
      })
      expect(receipt.status).toBe('complete')
      expect(verifyReceipt(receipt, RECEIPT_KEY)).toBe(true)
      expect(verifyReceipt(receipt, 'wrong-key')).toBe(false)
      // no secret leaked into the receipt
      expect(JSON.stringify(receipt)).not.toMatch(/encrypted_password|correct-horse/)

      console.log('upgrade fixture:', JSON.stringify(fixtureManifest()))
      console.log(
        'receipt invariants:',
        verified.invariants.map((i) => `${i.name}=${i.ok}`).join(' '),
      )
    } finally {
      await src.dispose()
      await tgt.dispose()
    }
  })

  it('a crash during table-data leaves the source intact and resumes to convergence', async () => {
    const src = await buildSource()
    const tgt = await buildTarget(target as NonNullable<typeof target>)
    try {
      const schema = (await import('../src/upgrade-fixture.js')).UPGRADE_FIXTURE_SCHEMA
      const bundle = await exportSource({
        adapter: src.adapter,
        schema,
        policies: src.policies,
        storage: src.storage,
        planId: `upg-crash-${Date.now()}`,
        preserveSessions: false,
        legacySigningKey: null,
      })
      const journalPath = join(scratch, 'j-crash.json')
      const journal = fileJournal(journalPath)

      // interrupt: throw at upgrade.during_table (a real abort mid-phase)
      await expect(
        importBundle({
          target: tgt.adapter,
          bundle,
          objects: tgt.objects,
          journal,
          deployPolicies: tgt.deployPolicies,
          ctx: {
            now: () => new Date().toISOString(),
            fault: oneShotFault('upgrade.during_table', 'throw'),
            receiptKey: RECEIPT_KEY,
          },
        }),
      ).rejects.toThrow()

      // the target is NOT announced ready
      const midJournal = await journal.load()
      expect(midJournal.every((e) => e.state === 'applied' && e.postcondition === true)).toBe(false)

      // the source is untouched
      const srcCount = (await src.adapter.execute(sql(`SELECT count(*)::int AS c FROM events`)))
        .rows[0] as { c: number }
      expect(srcCount.c).toBe(91)

      // resume from the journal → converges, no duplicate rows
      const resumed = await resumeUpgrade({
        target: tgt.adapter,
        bundle,
        objects: tgt.objects,
        journal,
        deployPolicies: tgt.deployPolicies,
        ctx: {
          now: () => new Date().toISOString(),
          fault: NULL_FAULT_PORT,
          receiptKey: RECEIPT_KEY,
        },
      })
      expect(resumed.completedThrough).toBe('legacy-signing-key')

      const verified = await verifyUpgrade({
        target: tgt.adapter,
        bundle,
        schema,
        objects: tgt.objects,
        expectSessionsRevoked: true,
      })
      expect(verified.invariants.filter((i) => !i.ok)).toEqual([])
      const eventCount = (await tgt.adapter.execute(sql(`SELECT count(*)::int AS c FROM events`)))
        .rows[0] as { c: number }
      expect(eventCount.c).toBe(91)
    } finally {
      await src.dispose()
      await tgt.dispose()
    }
  })
})

if (!target) {
  describe('upgrade (skipped)', () => {
    it.skip('needs the Supabase-local target — run `pnpm test:upgrade:local`', () => {})
  })
}
