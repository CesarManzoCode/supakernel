// Fault-injection / recovery campaign (contract §22, §30 L12). Every named fault point is
// exercised: a real interruption is forced at the point, then recovery + the point's
// invariant is asserted. Crash-critical points (`exit` mode) run in a child process so no
// `finally` executes; the rest force an in-transaction throw, which is an equally real abort.

import type { FaultName } from '@supakernel/ports'

export const FAULT_POINTS: readonly FaultName[] = [
  'migration.before_step',
  'migration.after_effect_before_journal',
  'migration.after_journal',
  'transaction.before_commit',
  'transaction.after_commit_before_response',
  'storage.after_reserve',
  'storage.after_bytes',
  'storage.after_promote',
  'storage.before_ready',
  'storage.after_ready',
  'storage.during_delete',
  'auth.after_parent_cas',
  'auth.after_child_insert',
  'auth.after_commit_before_response',
  'upgrade.after_schema',
  'upgrade.during_table',
  'upgrade.after_data_before_sequence',
  'upgrade.during_blob',
  'upgrade.before_receipt',
  'realtime.after_outbox_commit',
  'realtime.before_send',
  'realtime.after_send_before_cursor',
  'runtime.shutdown_during_request',
  'adapter.network_partition',
]

export type FaultOutcome = 'converged' | 'honest-block' | 'skipped'

export interface FaultCase {
  readonly point: FaultName
  /** How the interruption is delivered. */
  readonly mode: 'child-exit' | 'throw' | 'delay-throw' | 'adapter-error'
  run(): Promise<{ outcome: FaultOutcome; invariant: string; detail: string }>
}

export interface FaultCaseResult {
  readonly point: FaultName
  readonly mode: FaultCase['mode']
  readonly outcome: FaultOutcome
  readonly invariant: string
  readonly ok: boolean
  readonly detail: string
}

export async function runFaultCampaign(cases: readonly FaultCase[]): Promise<{
  results: FaultCaseResult[]
  covered: number
  ok: boolean
}> {
  const results: FaultCaseResult[] = []
  for (const c of cases) {
    try {
      const r = await c.run()
      results.push({
        point: c.point,
        mode: c.mode,
        outcome: r.outcome,
        invariant: r.invariant,
        ok: r.outcome !== 'skipped',
        detail: r.detail,
      })
    } catch (err) {
      results.push({
        point: c.point,
        mode: c.mode,
        outcome: 'skipped',
        invariant: '',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const covered = results.filter((r) => r.outcome !== 'skipped').length
  return { results, covered, ok: results.every((r) => r.ok) }
}
