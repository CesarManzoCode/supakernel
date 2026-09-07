import type { Json } from './json.js'

export interface ScenarioStep {
  readonly id: string
  readonly action: string
  readonly input: Json
}

export interface ObservationSpec {
  readonly id: string
  readonly of: 'response' | 'db-state' | 'mail' | 'object' | 'ws'
  readonly selector: Json
}

export type ComparatorMode =
  | 'exact'
  | 'ordered-sequence'
  | 'unordered-multiset'
  | 'subset'
  | 'predicate'
  | 'state-invariant'

export interface ComparisonSpec {
  readonly mode: ComparatorMode
  readonly extraVendorFields?: readonly string[]
}

export type NormalizerId =
  | 'uuid-bijection'
  | 'timestamp-window'
  | 'jwt-claims'
  | 'url-origin'
  | 'constraint-name'

/** Declarative, target-agnostic scenario definition (contract §8, §19.2). */
export interface ScenarioSpec {
  readonly schemaVersion: 1
  readonly id: string
  readonly capability: string
  readonly requires: readonly string[]
  readonly setup: readonly ScenarioStep[]
  readonly operations: readonly ScenarioStep[]
  readonly observe: readonly ObservationSpec[]
  readonly compare: ComparisonSpec
  readonly normalization: readonly NormalizerId[]
  readonly unsupported?: {
    readonly targets: readonly string[]
    readonly code: string
    readonly reason: string
  }
  readonly seed: string
}
