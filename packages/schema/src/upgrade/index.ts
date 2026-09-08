// SupaKernel upgrade engine (contract §17.2, §30 L12). Port-only: no driver import.

export {
  exportSource,
  fingerprintSource,
  multisetHash,
  type StorageReader,
  topoOrder,
} from './export.js'
export {
  type DeployPolicies,
  type ImportInput,
  type ImportResult,
  importBundle,
  type JournalStore,
} from './import.js'
export { type PlanUpgradeInput, planUpgrade } from './plan.js'
export { type BuildReceiptInput, buildReceipt, hmacSha256Hex, verifyReceipt } from './receipt.js'
export { firstIncompletePhase, type ResumeResult, resumeUpgrade } from './resume.js'
export type {
  AuthUserRecord,
  Fingerprint,
  ObjectTransfer,
  PhaseJournalEntry,
  PhaseState,
  StorageObjectRecord,
  UpgradeBundle,
  UpgradeContext,
  UpgradePhase,
  UpgradePlan,
  UpgradeReceipt,
  UpgradeRefusal,
} from './types.js'
export { UPGRADE_PHASES } from './types.js'
export {
  type InvariantResult,
  type PolicyProbe,
  type VerifyInput,
  verifyUpgrade,
} from './verify.js'
