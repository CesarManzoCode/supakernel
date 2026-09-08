// @supakernel/lab-upstream-evidence — evidence bundle generator (contract §28, §30 L13).
// Generates, never publishes. Upstream acceptance is external and is not fabricated.

export type { EvidenceBundle, EvidenceBundleInput } from './bundle.js'
export { buildEvidenceBundle, writeBundle } from './bundle.js'
export { buildStorageDivergenceBundle, STORAGE_404_DIVERGENCE } from './divergences.js'
export type { OwnershipCandidate, OwnershipInput } from './ownership.js'
export { classifyOwnership } from './ownership.js'
export type { Divergence, DivergenceObservation, ReduceHooks } from './reduce.js'
export { divergenceSignature, reduceDivergence } from './reduce.js'
export { draftIssue, draftPatchProposal } from './templates.js'
