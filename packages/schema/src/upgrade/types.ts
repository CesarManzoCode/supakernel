// Upgrade contract types (contract §17.2). The engine is port-only: it never imports a
// driver — the composition hands it a source `DatabaseAdapter`, a target `DatabaseAdapter`
// and an `ObjectTransfer` for the Storage API.

import type { Json, SchemaIR } from '@supakernel/contracts'
import type { FaultPort } from '@supakernel/ports'

export const UPGRADE_PHASES = [
  'plan',
  'readiness',
  'rehearsal',
  'writer-barrier',
  'schema',
  'auth',
  'table-data',
  'sequences',
  'policies-grants',
  'storage',
  'legacy-signing-key',
  'verification',
  'cutover-receipt',
] as const
export type UpgradePhase = (typeof UPGRADE_PHASES)[number]

export type PhaseState = 'pending' | 'running' | 'applied' | 'failed' | 'compensated'

export interface PhaseJournalEntry {
  readonly phase: UpgradePhase
  readonly state: PhaseState
  /** Observable postcondition result — resume restarts at the first non-`true`. */
  readonly postcondition: boolean | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly detail: string
}

export interface UpgradeRefusal {
  readonly code: string
  readonly reason: string
}

export interface Fingerprint {
  readonly family: 'postgres' | 'sqlite'
  readonly schemaHash: string
  readonly tableRowCounts: Readonly<Record<string, number>>
  readonly tableMultisetHash: Readonly<Record<string, string>>
  readonly sequences: Readonly<
    Record<string, { readonly last: string; readonly increment: string }>
  >
  readonly authUserCount: number
  readonly storageObjectCount: number
}

export interface UpgradePlan {
  readonly id: string
  readonly createdAt: string
  readonly source: Fingerprint
  /** Null until readiness has inspected a live target. */
  readonly target: { readonly nonEmpty: boolean; readonly systemSchemasPresent: boolean } | null
  readonly phases: readonly UpgradePhase[]
  readonly refusals: readonly UpgradeRefusal[]
  readonly canProceed: boolean
}

export interface AuthUserRecord {
  readonly id: string
  readonly email: string | null
  readonly encrypted_password: string | null
  readonly row: Readonly<Record<string, Json>>
  readonly identities: readonly Readonly<Record<string, Json>>[]
}

export interface StorageObjectRecord {
  readonly bucket: string
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly contentType: string | null
  readonly cacheControl: string | null
  readonly isPublic: boolean
  /** base64 bytes — canonical transfer encoding. */
  readonly bytesBase64: string
}

export interface UpgradeBundle {
  readonly planId: string
  readonly source: Fingerprint
  readonly schema: SchemaIR
  readonly authUsers: readonly AuthUserRecord[]
  /** FK-topological table order. */
  readonly tableOrder: readonly string[]
  readonly tableRows: Readonly<Record<string, readonly Readonly<Record<string, Json>>[]>>
  readonly sequences: Readonly<
    Record<
      string,
      {
        readonly last: string
        readonly increment: string
        readonly min: string
        readonly max: string
      }
    >
  >
  readonly policies: Json
  readonly storageObjects: readonly StorageObjectRecord[]
  /** A legacy signing key only when the operator explicitly asked to preserve sessions. */
  readonly legacySigningKey: { readonly kid: string; readonly jwk: Json } | null
}

/** The Storage-API side of the transfer — implemented by the composition against supabase-local. */
export interface ObjectTransfer {
  ensureBucket(bucket: string, isPublic: boolean): Promise<void>
  putObject(o: StorageObjectRecord): Promise<void>
  statObject(
    bucket: string,
    path: string,
  ): Promise<{ size: number; sha256: string; contentType: string | null } | null>
  listObjects(): Promise<{ bucket: string; path: string }[]>
}

export interface UpgradeReceipt {
  readonly schemaVersion: 1
  readonly planId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly source: Fingerprint
  readonly target: Fingerprint
  readonly journal: readonly PhaseJournalEntry[]
  readonly invariants: readonly {
    readonly name: string
    readonly ok: boolean
    readonly detail: string
  }[]
  readonly sessionsRevoked: boolean
  readonly status: 'complete' | 'incomplete'
  /** HMAC-SHA256 over the canonical receipt body (no secrets). */
  readonly signature: string
}

export interface UpgradeContext {
  readonly now: () => string
  readonly fault: FaultPort
  /** HMAC key for the receipt signature — derived from the operator secret, never stored. */
  readonly receiptKey: string
}
