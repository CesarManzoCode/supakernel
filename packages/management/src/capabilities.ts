import { DEFAULT_RUNTIME_LIMITS, type Json, type RuntimeId } from '@supakernel/contracts'

export interface CapabilityInput {
  readonly runtime: RuntimeId
  readonly databaseFamilies: readonly ('postgres' | 'sqlite')[]
  readonly services: readonly ('data' | 'auth' | 'storage' | 'realtime' | 'management')[]
  readonly exclusions: readonly string[]
  readonly limits?: Partial<typeof DEFAULT_RUNTIME_LIMITS>
  readonly coreHash: string
}

/** The `/.well-known/supakernel-capabilities` document (contract §10, §16). */
export function buildCapabilities(input: CapabilityInput): Json {
  return {
    schemaVersion: 1,
    runtime: input.runtime,
    core_hash: input.coreHash,
    services: {
      data: input.services.includes('data'),
      auth: input.services.includes('auth'),
      storage: input.services.includes('storage'),
      realtime: input.services.includes('realtime'),
      management: input.services.includes('management') ? 'read-only-plus-loopback-sql' : false,
    },
    database: { families: [...input.databaseFamilies] },
    limits: { ...DEFAULT_RUNTIME_LIMITS, ...(input.limits ?? {}) },
    exclusions: [...input.exclusions],
  }
}
