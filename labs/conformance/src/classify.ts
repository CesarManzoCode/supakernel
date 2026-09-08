// Single diff classification (contract §19.2).

import type { Json } from '@supakernel/contracts'
import type { DiffEntry } from './compare.js'

export type DiffClass =
  | 'match'
  | 'kernel_regression'
  | 'vendor_divergence'
  | 'supalite_divergence'
  | 'intentional_divergence'
  | 'normalizer_bug'
  | 'environment_failure'

/** The six contract classifications for an actual diff (contract §19.2); `match` is the
 *  no-diff case and is not one of them. */
export const DIFF_CLASSES: readonly DiffClass[] = [
  'kernel_regression',
  'vendor_divergence',
  'supalite_divergence',
  'intentional_divergence',
  'normalizer_bug',
  'environment_failure',
] as const

export const BLOCKING_CLASSES: readonly DiffClass[] = ['kernel_regression'] as const

export interface RegisteredDivergence {
  readonly id: string
  readonly scenario: string
  /** Substring match against a diff path; `*` matches any path. */
  readonly path: string
  readonly kind: 'intentional' | 'normalizer'
  readonly rationale: string
  /** Security review reference / tests that pin the behaviour. */
  readonly evidence: readonly string[]
}

export interface TargetInfo {
  readonly id: string
  readonly nature: 'vendor' | 'blackbox' | 'product' | 'external'
}

export interface ClassifyInput {
  readonly scenario: string
  readonly target: TargetInfo
  readonly diffs: readonly DiffEntry[]
  /** True when the oracle (supabase-local or embedded golden) itself agreed with a
   *  secondary vendor reference — lets an unexpected kernel diff be a regression, not a
   *  vendor divergence. */
  readonly secondaryVendorAgrees: boolean
  readonly targetFailure?: string
  readonly registry: readonly RegisteredDivergence[]
}

export interface Classification {
  readonly class: DiffClass
  readonly blocking: boolean
  readonly diffs: readonly DiffEntry[]
  readonly matchedRegistryIds: readonly string[]
  readonly note: string
}

function matches(reg: RegisteredDivergence, scenario: string, diff: DiffEntry): boolean {
  if (reg.scenario !== scenario) return false
  return reg.path === '*' || diff.path.includes(reg.path)
}

export function classify(input: ClassifyInput): Classification {
  if (input.targetFailure !== undefined) {
    return {
      class: 'environment_failure',
      blocking: false,
      diffs: input.diffs,
      matchedRegistryIds: [],
      note: `target provisioning/health failure: ${input.targetFailure}`,
    }
  }

  if (input.diffs.length === 0) {
    return {
      class: 'match',
      blocking: false,
      diffs: [],
      matchedRegistryIds: [],
      note: 'observations match the oracle',
    }
  }

  // Every diff must be explained by a registered divergence, otherwise the residual set is
  // classified by target nature.
  const matchedIds = new Set<string>()
  const residual: DiffEntry[] = []
  let sawNormalizer = false
  for (const diff of input.diffs) {
    const reg = input.registry.find((r) => matches(r, input.scenario, diff))
    if (reg) {
      matchedIds.add(reg.id)
      if (reg.kind === 'normalizer') sawNormalizer = true
    } else {
      residual.push(diff)
    }
  }

  if (residual.length === 0) {
    return {
      class: sawNormalizer ? 'normalizer_bug' : 'intentional_divergence',
      blocking: false,
      diffs: input.diffs,
      matchedRegistryIds: [...matchedIds],
      note: 'all diffs explained by the divergence registry',
    }
  }

  switch (input.target.nature) {
    case 'blackbox':
      return {
        class: 'supalite_divergence',
        blocking: false,
        diffs: residual,
        matchedRegistryIds: [...matchedIds],
        note: 'black-box package differs from the oracle; recorded, does not block the kernel',
      }
    case 'vendor':
      return {
        class: 'vendor_divergence',
        blocking: false,
        diffs: residual,
        matchedRegistryIds: [...matchedIds],
        note: 'two references disagree; no winner without a reference trace',
      }
    case 'external':
      return {
        class: 'vendor_divergence',
        blocking: false,
        diffs: residual,
        matchedRegistryIds: [...matchedIds],
        note: 'external artifact source differs; opt-in lane',
      }
    case 'product': {
      const isRegression = input.secondaryVendorAgrees || true
      return {
        class: isRegression ? 'kernel_regression' : 'vendor_divergence',
        blocking: isRegression,
        diffs: residual,
        matchedRegistryIds: [...matchedIds],
        note: 'kernel differs from the oracle on the included surface with no registered rationale',
      }
    }
    default: {
      const never: never = input.target.nature
      throw new Error(`unhandled target nature ${String(never)}`)
    }
  }
}

export function registryToJson(registry: readonly RegisteredDivergence[]): Json {
  return registry as unknown as Json
}
