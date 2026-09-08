// Hidden, tamper-resistant scorer (contract §24). State-based only — it inspects the live
// project + the workspace diff, never the transcript's self-reported success. The scorer
// hash is committed; a run whose sandbox lacks the untouched scorer marker is void.

import { canonicalJson, type Json, sha256Hex } from '@supakernel/contracts'

export interface ScorerContext {
  /** Query the live project's HTTP surface (the agent's finished state). */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** The workspace diff the agent produced (paths + added/removed line counts). */
  readonly workspaceDiff: Readonly<Record<string, { added: number; removed: number }>>
  /** Security probe results collected by the harness during the run. */
  readonly securityProbes: readonly { name: string; passed: boolean; detail: string }[]
}

export interface ScoreOutcome {
  readonly success: boolean
  readonly securityViolations: number
  readonly invalidApiAttempts: number
  readonly destructiveMistakes: number
  readonly checks: readonly { name: string; ok: boolean; detail: string }[]
}

export type Scorer = (ctx: ScorerContext) => Promise<ScoreOutcome>

/** A scorer's identity, committed so tampering is detectable. */
export function scorerHash(source: string): string {
  return sha256Hex(source.replace(/\s+/g, ' ').trim())
}

/** Tamper check: the sandbox must still carry the exact scorer marker the harness planted. */
export function assertScorerUntampered(plantedMarker: string, foundMarker: string | null): void {
  if (foundMarker !== plantedMarker) {
    throw new Error(
      'SK_EVAL_SCORER_TAMPERED: the hidden scorer marker was altered or removed — run void',
    )
  }
}

/** Aggregate a task's repetitions into a variant summary (contract §24 — report distributions,
 *  never a single number; a claim needs a non-overlapping bootstrap interval + no security
 *  regression). */
export interface VariantSummary {
  readonly variant: 'A' | 'B'
  readonly task: string
  readonly repetitions: number
  readonly successRate: number
  readonly securityViolations: number
  readonly meanWallMs: number
  readonly meanTurns: number
  readonly meanTokens: number
}

export function summarizeVariant(
  variant: 'A' | 'B',
  task: string,
  results: readonly import('./tasks.js').TaskResult[],
): VariantSummary {
  const n = results.length || 1
  return {
    variant,
    task,
    repetitions: results.length,
    successRate: results.filter((r) => r.success).length / n,
    securityViolations: results.reduce((a, r) => a + r.securityViolations, 0),
    meanWallMs: results.reduce((a, r) => a + r.wallMs, 0) / n,
    meanTurns: results.reduce((a, r) => a + r.turns, 0) / n,
    meanTokens: results.reduce((a, r) => a + r.tokens, 0) / n,
  }
}

export function canonicalScore(o: ScoreOutcome): string {
  return sha256Hex(canonicalJson(o as unknown as Json))
}
