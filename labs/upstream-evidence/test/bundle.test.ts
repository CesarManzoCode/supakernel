import { describe, expect, it } from 'vitest'
import {
  buildStorageDivergenceBundle,
  classifyOwnership,
  divergenceSignature,
  reduceDivergence,
  STORAGE_404_DIVERGENCE,
} from '../src/index.js'

describe('upstream evidence bundle (contract §28)', () => {
  it('the storage 400-vs-404 divergence has a real, complete bundle', () => {
    const b = buildStorageDivergenceBundle()
    expect(b.published).toBe(false)
    expect(b.divergence.expected.status).toBe(404)
    expect(b.divergence.actual.status).toBe(400)
    expect(b.facts.length).toBeGreaterThanOrEqual(4)
    expect(b.causalHypothesis).toMatch(/hypothesis/i)
    expect(b.sourceSymbols.length).toBeGreaterThan(0)
    expect(b.ownership.repo).toBe('supabase/storage')
    expect(b.ownership.score).toBeGreaterThan(0.5)
    expect(b.securityReview).toMatch(/no secret/i)
    expect(b.draftIssue).toContain('DRAFT')
    expect(b.draftIssue).toContain('NOT submitted')
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the divergence signature is stable', () => {
    expect(divergenceSignature(STORAGE_404_DIVERGENCE)).toBe(
      divergenceSignature(STORAGE_404_DIVERGENCE),
    )
  })

  it('the reducer keeps only the steps that preserve the signature', async () => {
    const target = divergenceSignature(STORAGE_404_DIVERGENCE)
    const { minimalSteps, signature } = await reduceDivergence(STORAGE_404_DIVERGENCE, {
      async evaluate(stepIds) {
        // the divergence needs a bucket + the GET; upload/delete are noise
        return stepIds.includes('create-private-bucket') && stepIds.includes('get-missing-object')
          ? target
          : ''
      },
    })
    expect(signature).toBe(target)
    expect([...minimalSteps].sort()).toEqual(['create-private-bucket', 'get-missing-object'])
  })

  it('ownership classification is explainable', () => {
    const o = classifyOwnership({
      capability: 'storage',
      symbols: ['getObject'],
      observedIn: 'supabase/storage',
    })
    expect(o.rationale).toContain('storage')
    expect(o.contributing).toContain('CONTRIBUTING')
  })
})
