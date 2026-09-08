// Delta-debugging reduction of a divergence to its minimal reproducer (contract §28). The
// reducer never changes the diff signature — a reduction that alters or clears the observed
// divergence is rejected.

import { canonicalJson, type Json, sha256Hex } from '@supakernel/contracts'

export interface DivergenceObservation {
  readonly system: string
  readonly status: number
  readonly bodyShape: Json
}

export interface Divergence {
  readonly id: string
  /** Two real systems, disagreeing. */
  readonly expected: DivergenceObservation
  readonly actual: DivergenceObservation
  /** The reproducing steps (each removable by the reducer). */
  readonly steps: readonly { readonly id: string; readonly required: boolean }[]
}

/** A stable signature of the divergence — status delta + body-shape delta. */
export function divergenceSignature(d: Divergence): string {
  return sha256Hex(
    canonicalJson({
      status: [d.expected.status, d.actual.status],
      body: [d.expected.bodyShape, d.actual.bodyShape],
    } as Json),
  )
}

export interface ReduceHooks {
  /** Re-run with the given step subset and return the divergence signature, or '' if it no
   *  longer reproduces. */
  evaluate(stepIds: readonly string[]): Promise<string>
}

/** ddmin over the step list, preserving the divergence signature. */
export async function reduceDivergence(
  d: Divergence,
  hooks: ReduceHooks,
): Promise<{ minimalSteps: string[]; signature: string }> {
  const target = await hooks.evaluate(d.steps.map((s) => s.id))
  if (target === '') throw new Error('divergence does not reproduce; nothing to reduce')

  let keep = d.steps.map((s) => s.id)
  let changed = true
  while (changed) {
    changed = false
    for (const step of [...keep].reverse()) {
      const candidate = keep.filter((s) => s !== step)
      if (candidate.length === 0) continue
      if ((await hooks.evaluate(candidate)) === target) {
        keep = candidate
        changed = true
      }
    }
  }
  return { minimalSteps: keep, signature: target }
}
