import type { Family } from './identifiers.ts'

export type IsolationLevel = 'read-committed' | 'serializable'

/**
 * What a database adapter can actually do (contract §8). Lying about a capability fails
 * `SK_CAPABILITY_ATTESTATION` in the connection contract suite (§9.3).
 */
export interface DatabaseCapabilities {
  readonly family: Family
  readonly transactions: 'callback' | 'atomic-batch' | 'none'
  readonly ddlAtomicity: 'transactional' | 'step-journal'
  readonly nativeRls: boolean
  readonly returning: boolean
  readonly json: 'native-jsonb' | 'json-text'
  readonly changeCapture: 'managed-triggers' | 'none'
  readonly isolation: readonly IsolationLevel[]
}

export interface RuntimeLimits {
  readonly maxRequestBodyBytes: number
  readonly maxObjectUploadBytes: number
  readonly maxQueryParams: number
  readonly maxExprDepth: number
  readonly defaultRowLimit: number
  readonly maxRowLimit: number
  readonly requestTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly socketQueueBytes: number
  readonly socketQueueEvents: number
}

/** Normative defaults (contract §10). A runtime profile may only reduce these. */
export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxRequestBodyBytes: 10 * 1024 * 1024,
  maxObjectUploadBytes: 50 * 1024 * 1024,
  maxQueryParams: 100,
  maxExprDepth: 12,
  defaultRowLimit: 1_000,
  maxRowLimit: 10_000,
  requestTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000,
  socketQueueBytes: 1024 * 1024,
  socketQueueEvents: 1_024,
}

export interface CapabilityManifest {
  readonly runtime: string
  readonly family: Family
  readonly database: DatabaseCapabilities
  readonly limits: RuntimeLimits
  readonly services: readonly string[]
}
