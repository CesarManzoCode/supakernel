// Target port (contract §19.1). Every target — the product, a real vendor stack, a black-box
// package, an opt-in hosted project, an external CLI's artifacts — implements exactly this.
// The runner and interpreter never inspect `id`.

import type { ScenarioSpec } from '@supakernel/contracts'
import type { ControlChannel } from './control.js'
import type { TargetClient } from './interpret.js'

export type TargetNature = 'vendor' | 'blackbox' | 'product' | 'external'
export type TargetGate = 'mandatory' | 'nightly' | 'opt-in'

export interface TargetHealth {
  readonly ok: boolean
  readonly detail: string
}

export interface TargetSession {
  readonly control: ControlChannel
  readonly client: TargetClient
  dispose(): Promise<void>
}

export interface Target {
  readonly id: string
  readonly nature: TargetNature
  readonly gate: TargetGate
  /** Which capabilities this target can serve as an oracle / candidate. */
  readonly capabilities: readonly string[]
  health(): Promise<TargetHealth>
  /** Provision an isolated session for one scenario. Throws on provisioning failure — the
   *  runner turns that into `environment_failure`, never a pass. */
  open(scenario: ScenarioSpec): Promise<TargetSession>
}

/** A target that only imports pre-computed artifacts (SupaDiff). */
export interface ExternalArtifactTarget {
  readonly id: string
  readonly nature: 'external'
  readonly gate: 'opt-in'
  available(): Promise<boolean>
  /** Convert an external artifact for this scenario into normalized observations. */
  importObservation(scenario: ScenarioSpec): Promise<import('./schema.js').TargetRunResult | null>
}
