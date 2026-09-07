import type { ProjectSchema } from './schema.js'

/**
 * The result of `introspect()` (contract §9.2, §17.1). Normalized so that a round-trip
 * `apply` → `introspect` can be compared to the desired `SchemaIR` without losing defaults,
 * identity / sequence ownership, constraints, indexes or policies.
 */
export interface ObservedSchema extends ProjectSchema {
  readonly observedAt: string
  /** Objects the adapter saw that are outside the portable subset — reported, never silently dropped. */
  readonly unmodeled: readonly UnmodeledObject[]
}

export interface UnmodeledObject {
  readonly kind: 'table' | 'column' | 'constraint' | 'index' | 'trigger' | 'type' | 'other'
  readonly name: string
  readonly reason: string
}
