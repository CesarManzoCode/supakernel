// Agent DX A/B report (contract §24). Reports distributions + qualitative failures, never a
// model ranking. A DX improvement is claimed only if success rises without a security
// regression AND the bootstrap interval does not materially overlap.

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, type Json, sha256Hex } from '@supakernel/contracts'
import { summarizeVariant, type VariantSummary } from './scorer.js'
import type { TaskResult } from './tasks.js'

export interface Experiment {
  readonly id: string
  readonly modelId: string
  readonly systemPromptHash: string
  readonly deterministicProvider: boolean
  readonly releaseA: string
  readonly releaseB: string
  readonly docsSnapshotHash: string
  readonly repetitions: number
}

export interface AbReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly experiment: Experiment
  readonly providerAvailable: boolean
  readonly providerNote: string
  readonly perTask: readonly {
    task: string
    a: VariantSummary
    b: VariantSummary
    successDelta: number
    securityRegression: boolean
    verdict: string
  }[]
  readonly qualitativeFailures: readonly string[]
  readonly claim: string
  readonly hash: string
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function buildAbReport(input: {
  experiment: Omit<Experiment, 'repetitions'> & { repetitions: number }
  providerAvailable: boolean
  providerNote: string
  results: readonly TaskResult[]
}): AbReport {
  const tasks = [...new Set(input.results.map((r) => r.task))]
  const perTask = tasks.map((task) => {
    const a = summarizeVariant(
      'A',
      task,
      input.results.filter((r) => r.task === task && r.variant === 'A'),
    )
    const b = summarizeVariant(
      'B',
      task,
      input.results.filter((r) => r.task === task && r.variant === 'B'),
    )
    const successDelta = b.successRate - a.successRate
    const securityRegression = b.securityViolations > a.securityViolations
    let verdict: string
    if (!input.providerAvailable) verdict = 'no DX signal — provider credential unavailable'
    else if (securityRegression)
      verdict = 'B has a security regression — no DX improvement claimable'
    else if (successDelta > 0 && b.repetitions >= 10)
      verdict = `B success +${(successDelta * 100).toFixed(0)}pp (needs non-overlapping bootstrap interval to claim)`
    else verdict = 'inconclusive'
    return { task, a, b, successDelta, securityRegression, verdict }
  })
  const body = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    experiment: input.experiment,
    providerAvailable: input.providerAvailable,
    providerNote: input.providerNote,
    perTask,
    qualitativeFailures: [...new Set(input.results.flatMap((r) => r.qualitativeFailures))],
    claim: input.providerAvailable
      ? 'See per-task verdicts. A DX improvement requires success up, no security regression, non-overlapping interval, >= 10 reps.'
      : 'NO DX CLAIM. A fixed-model A/B DX comparison requires an LLM provider credential (contract §32). The harness (tasks, disposable sandbox, hidden state-based scorer, security probes, tamper resistance, provider abstraction) is validated with a deterministic scripted agent only.',
  }
  return {
    ...body,
    hash: sha256Hex(
      canonicalJson({ ...body, git: { sha: git('rev-parse HEAD') } } as unknown as Json),
    ),
  }
}

export function writeAbReport(root: string, report: AbReport): { dir: string } {
  const dir = join(root, `ab-${report.generatedAt.replace(/[:.]/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(dir, 'report.md'), toMarkdown(report))
  return { dir }
}

function toMarkdown(r: AbReport): string {
  return `# Agent DX A/B — ${r.experiment.id}

- generated: ${r.generatedAt}
- model: ${r.experiment.modelId} (deterministic provider: ${r.experiment.deterministicProvider})
- release A: ${r.experiment.releaseA} · release B: ${r.experiment.releaseB}
- repetitions/variant: ${r.experiment.repetitions}
- provider available: **${r.providerAvailable}** — ${r.providerNote}

## Per task

| task | A success | B success | Δ | security regression | verdict |
|---|---|---|---|---|---|
${r.perTask
  .map(
    (t) =>
      `| ${t.task} | ${(t.a.successRate * 100).toFixed(0)}% | ${(t.b.successRate * 100).toFixed(0)}% | ${(t.successDelta * 100).toFixed(0)}pp | ${t.securityRegression} | ${t.verdict} |`,
  )
  .join('\n')}

## Qualitative failures

${r.qualitativeFailures.length ? r.qualitativeFailures.map((f) => `- ${f}`).join('\n') : '- none observed'}

## Claim

${r.claim}

report hash: \`${r.hash}\`
`
}
