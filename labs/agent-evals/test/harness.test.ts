import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anthropicProvider,
  assertScorerUntampered,
  buildAbReport,
  makeSandbox,
  runSecurityProbes,
  SECURITY_PROBES,
  scriptedProvider,
  TASKS_V1,
  validateProjectName,
} from '../src/index.js'

describe('agent eval harness (contract §24)', () => {
  it('every v1 task has a public prompt, a hidden scorer and a budget', () => {
    expect(TASKS_V1.length).toBe(7)
    for (const t of TASKS_V1) {
      expect(t.publicPrompt.length).toBeGreaterThan(20)
      expect(t.hiddenScorer.length).toBeGreaterThan(10)
      expect(t.budget.turns).toBeGreaterThan(0)
    }
  })

  it('the sandbox strips every credential and denies network', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-be-stripped'
    process.env.MY_SECRET_TOKEN = 'stripme'
    const s = makeSandbox('eval-test', { 'quickstart.md': '# docs' })
    try {
      expect(s.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(s.env.MY_SECRET_TOKEN).toBeUndefined()
      expect(s.env.NO_NETWORK).toBe('1')
      expect(readFileSync(join(s.docsDir, 'quickstart.md'), 'utf8')).toBe('# docs')
    } finally {
      s.dispose()
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.MY_SECRET_TOKEN
    }
  })

  it('rejects invalid project names', () => {
    expect(validateProjectName('good-name')).toBe(true)
    expect(validateProjectName('../etc/passwd')).toBe(false)
    expect(validateProjectName('A')).toBe(false)
  })

  it('the scorer tamper check voids a run whose marker was altered', () => {
    expect(() => assertScorerUntampered('planted', 'planted')).not.toThrow()
    expect(() => assertScorerUntampered('planted', 'tampered')).toThrow(/TAMPERED/)
    expect(() => assertScorerUntampered('planted', null)).toThrow(/TAMPERED/)
  })

  it('the anthropic provider is unavailable without a credential (external blocker, §32)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.SUPAKERNEL_EVAL_ANTHROPIC_KEY
    const p = anthropicProvider('claude-sonnet-5')
    const a = await p.available()
    expect(a.ok).toBe(false)
    expect(a.detail).toMatch(/credential|ANTHROPIC/i)
    await expect(p.run({} as never)).rejects.toThrow()
  })

  it('the scripted provider validates the harness but carries no DX signal', async () => {
    const p = scriptedProvider()
    expect((await p.available()).ok).toBe(true)
    expect(p.deterministic).toBe(true)
  })

  it('a report with no provider makes NO DX claim', () => {
    const report = buildAbReport({
      experiment: { id: 'x', modelId: 'm', systemPromptHash: 'h', deterministicProvider: true, releaseA: 'a', releaseB: 'b', docsSnapshotHash: 'd', repetitions: 1 },
      providerAvailable: false,
      providerNote: 'no key',
      results: [],
    })
    expect(report.claim).toMatch(/NO DX CLAIM/)
    expect(report.providerAvailable).toBe(false)
  })

  it('security probes are all present and callable', () => {
    expect(SECURITY_PROBES.length).toBeGreaterThanOrEqual(4)
    expect(typeof runSecurityProbes).toBe('function')
  })
})
