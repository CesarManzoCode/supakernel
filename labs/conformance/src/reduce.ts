// Delta-debugging reducer (contract §19.2, §26). Shrinks a failing scenario over its steps
// and seed rows while preserving the *diff signature* — the classified, normalized failure
// fingerprint. A reduction that changes or clears the signature is rejected.

import type { ScenarioSpec, ScenarioStep } from '@supakernel/contracts'
import { canonicalJson, sha256Hex } from '@supakernel/contracts'
import type { Classification } from './classify.js'
import type { DiffEntry } from './compare.js'
import { stepInput } from './schema.js'

export function diffSignature(
  classifications: readonly { target: string; classification: Classification }[],
): string {
  const canon = classifications
    .filter((c) => c.classification.blocking)
    .map((c) => ({
      target: c.target,
      class: c.classification.class,
      diffs: [...c.classification.diffs]
        .map((d: DiffEntry) => ({ path: d.path, note: d.note }))
        .sort((a, b) => (a.path + a.note).localeCompare(b.path + b.note)),
    }))
    .sort((a, b) => a.target.localeCompare(b.target))
  return sha256Hex(canonicalJson(canon as unknown as import('@supakernel/contracts').Json))
}

export interface ReduceHooks {
  /** Run the candidate scenario and return the blocking diff signature (or '' if it passes). */
  evaluate(candidate: ScenarioSpec): Promise<string>
}

function withoutStep(steps: readonly ScenarioStep[], drop: ReadonlySet<number>): ScenarioStep[] {
  return steps.filter((_, i) => !drop.has(i))
}

function trimSeedRows(step: ScenarioStep, keep: number): ScenarioStep {
  const input = stepInput(step)
  if (!Array.isArray(input.rows)) return step
  return { ...step, input: { ...input, rows: input.rows.slice(0, keep) } }
}

/**
 * ddmin-style reduction: try removing individual operations, then individual setup steps,
 * then shrinking each `db.seed` row list, always keeping the original diff signature.
 */
export async function reduceScenario(
  scenario: ScenarioSpec,
  hooks: ReduceHooks,
): Promise<{ reduced: ScenarioSpec; signature: string; steps: number }> {
  const target = await hooks.evaluate(scenario)
  if (target === '') {
    throw new Error('scenario does not reproduce a blocking diff; nothing to reduce')
  }

  let current = scenario

  // 1. drop operations one at a time (last-to-first keeps earlier ids stable)
  let changed = true
  while (changed) {
    changed = false
    for (let i = current.operations.length - 1; i >= 0; i--) {
      if (current.operations.length <= 1) break
      const candidate: ScenarioSpec = {
        ...current,
        operations: withoutStep(current.operations, new Set([i])),
      }
      if ((await hooks.evaluate(candidate)) === target) {
        current = candidate
        changed = true
      }
    }
  }

  // 2. drop setup steps
  changed = true
  while (changed) {
    changed = false
    for (let i = current.setup.length - 1; i >= 0; i--) {
      const candidate: ScenarioSpec = {
        ...current,
        setup: withoutStep(current.setup, new Set([i])),
      }
      if ((await hooks.evaluate(candidate)) === target) {
        current = candidate
        changed = true
      }
    }
  }

  // 3. shrink seed rows
  for (let i = 0; i < current.setup.length; i++) {
    const step = current.setup[i]
    if (step?.action !== 'db.seed') continue
    const rows = stepInput(step).rows
    if (!Array.isArray(rows)) continue
    for (let keep = 0; keep < rows.length; keep++) {
      const candidate: ScenarioSpec = {
        ...current,
        setup: current.setup.map((s, j) => (j === i ? trimSeedRows(s, keep) : s)),
      }
      if ((await hooks.evaluate(candidate)) === target) {
        current = candidate
        break
      }
    }
  }

  return {
    reduced: current,
    signature: target,
    steps: current.setup.length + current.operations.length,
  }
}
