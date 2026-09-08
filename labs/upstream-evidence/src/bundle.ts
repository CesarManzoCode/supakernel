// Evidence bundle assembly (contract §28). Generates a self-contained, human-review-ready
// bundle: minimal reproducer, expected/actual raw + normalized, versions/SHAs/digests, seed,
// one-command replay, causal hypothesis (separate from facts), candidate source symbols,
// impact/capability, security/redaction review, license, draft issue, ownership score.
// It NEVER publishes.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, type Json, sha256Hex } from '@supakernel/contracts'
import type { OwnershipCandidate } from './ownership.js'
import type { Divergence } from './reduce.js'
import { divergenceSignature } from './reduce.js'
import { draftIssue } from './templates.js'

export interface EvidenceBundleInput {
  readonly divergence: Divergence
  readonly minimalSteps: readonly string[]
  readonly capability: 'data' | 'auth' | 'storage' | 'realtime' | 'cli' | 'benchmark'
  readonly versions: Readonly<Record<string, string>>
  readonly digests: Readonly<Record<string, string>>
  readonly seed: string
  readonly replayCommand: string
  /** Facts only — what was observed. */
  readonly facts: readonly string[]
  /** Hypothesis — explicitly separated from facts. */
  readonly causalHypothesis: string
  /** Candidate upstream source symbols. */
  readonly sourceSymbols: readonly string[]
  readonly impact: string
  readonly securityReview: string
  readonly redactionReview: string
  readonly license: string
  readonly ownership: OwnershipCandidate
  /** A minimal reproducer script that does NOT depend on SupaKernel, when possible. */
  readonly reproducer: string
}

export interface EvidenceBundle {
  readonly schemaVersion: 1
  readonly id: string
  readonly generatedAt: string
  readonly signature: string
  readonly divergence: Divergence
  readonly minimalSteps: readonly string[]
  readonly versions: Readonly<Record<string, string>>
  readonly digests: Readonly<Record<string, string>>
  readonly seed: string
  readonly replayCommand: string
  readonly facts: readonly string[]
  readonly causalHypothesis: string
  readonly sourceSymbols: readonly string[]
  readonly impact: string
  readonly securityReview: string
  readonly redactionReview: string
  readonly license: string
  readonly ownership: OwnershipCandidate
  readonly draftIssue: string
  readonly published: false
  readonly hash: string
}

export function buildEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  const signature = divergenceSignature(input.divergence)
  const body = {
    schemaVersion: 1 as const,
    id: input.divergence.id,
    generatedAt: new Date().toISOString(),
    signature,
    divergence: input.divergence,
    minimalSteps: input.minimalSteps,
    versions: input.versions,
    digests: input.digests,
    seed: input.seed,
    replayCommand: input.replayCommand,
    facts: input.facts,
    causalHypothesis: input.causalHypothesis,
    sourceSymbols: input.sourceSymbols,
    impact: input.impact,
    securityReview: input.securityReview,
    redactionReview: input.redactionReview,
    license: input.license,
    ownership: input.ownership,
    draftIssue: draftIssue({
      title: `${input.capability}: ${input.divergence.id}`,
      facts: input.facts,
      hypothesis: input.causalHypothesis,
      repro: input.reproducer,
      replay: input.replayCommand,
      versions: input.versions,
      impact: input.impact,
    }),
    published: false as const,
  }
  return { ...body, hash: sha256Hex(canonicalJson(body as unknown as Json)) }
}

export function writeBundle(
  root: string,
  bundle: EvidenceBundle,
  reproducer: string,
): { dir: string } {
  const dir = join(root, bundle.id)
  mkdirSync(join(dir, 'reproducer'), { recursive: true })
  writeFileSync(join(dir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)
  writeFileSync(join(dir, 'draft-issue.md'), bundle.draftIssue)
  writeFileSync(join(dir, 'reproducer', 'repro.sh'), reproducer)
  return { dir }
}
