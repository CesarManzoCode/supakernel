import type { DatabaseAdapter } from '@supakernel/ports'

/**
 * The shared Database connection contract suite (contract §9.3). Every L2 adapter calls
 * `runDatabaseContractSuite` with a factory that opens a fresh adapter against a disposable
 * resource, plus a re-open factory for the crash/reopen case.
 *
 * The suite body (the 12 canonical cases) is implemented in L2 — this module fixes its shape
 * so adapters and their tests can be written against a stable signature.
 */
export interface DatabaseContractHarness {
  readonly label: string
  /** Open a brand-new adapter over an empty, disposable resource. */
  open(): Promise<DatabaseAdapter>
  /** Re-open the adapter over the *same* resource, without cleaning it (crash/reopen case). */
  reopen(): Promise<DatabaseAdapter>
  /** Delete the disposable resource and release any handles. */
  cleanup(): Promise<void>
}

export type DatabaseContractCase =
  | 'open-close-idempotent'
  | 'bind-null-bytes-int64-json'
  | 'constraint-mapping'
  | 'transaction-commit-rollback'
  | 'concurrent-writers'
  | 'declared-isolation'
  | 'introspection-round-trip'
  | 'rls-or-predicate'
  | 'returning-rows'
  | 'outbox-trigger'
  | 'crash-reopen'
  | 'capability-attestation'
  | 'resource-cleanup'

export const DATABASE_CONTRACT_CASES: readonly DatabaseContractCase[] = [
  'open-close-idempotent',
  'bind-null-bytes-int64-json',
  'constraint-mapping',
  'transaction-commit-rollback',
  'concurrent-writers',
  'declared-isolation',
  'introspection-round-trip',
  'rls-or-predicate',
  'returning-rows',
  'outbox-trigger',
  'crash-reopen',
  'capability-attestation',
  'resource-cleanup',
]
