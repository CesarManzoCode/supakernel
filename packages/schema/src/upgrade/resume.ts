// Resume (contract §17.2 — "puede reanudarse"). Re-reads the persisted phase journal and
// restarts `importBundle` at the first phase whose observable postcondition is not `true`.
// The source is never touched; a target that is still incomplete is never announced ready.

import { type ImportInput, type ImportResult, importBundle, type JournalStore } from './import.js'
import type { PhaseJournalEntry, UpgradePhase } from './types.js'
import { UPGRADE_PHASES } from './types.js'

/** The first phase that must re-run: earliest entry that is not `applied` with a true
 *  postcondition. */
export function firstIncompletePhase(journal: readonly PhaseJournalEntry[]): UpgradePhase | null {
  for (const phase of UPGRADE_PHASES) {
    const e = journal.find((j) => j.phase === phase)
    if (!e) return phase
    if (e.state === 'applied' && e.postcondition === true) continue
    // verification / cutover-receipt are driven by the caller, not importBundle
    if (
      phase === 'verification' ||
      phase === 'cutover-receipt' ||
      phase === 'plan' ||
      phase === 'readiness' ||
      phase === 'rehearsal' ||
      phase === 'writer-barrier'
    ) {
      continue
    }
    return phase
  }
  return null
}

export interface ResumeResult extends ImportResult {
  readonly restartedAt: UpgradePhase | null
}

export async function resumeUpgrade(input: ImportInput): Promise<ResumeResult> {
  const journal = await input.journal.load()
  const restartedAt = firstIncompletePhase(journal)
  // importBundle itself is idempotent per phase: it skips phases already `applied` with a
  // true postcondition and re-runs the rest.
  const result = await importBundle(input)
  return { ...result, restartedAt }
}

export type { JournalStore }
