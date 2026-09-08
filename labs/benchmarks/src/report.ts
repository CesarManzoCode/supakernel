// Benchmark report (contract §23, §26). Raw samples + environment + durability + validator
// result + bootstrap CIs + an explicit winner/inconclusive verdict per metric. A comparative
// claim is only permitted when §23's anti-gaming rules are met AND the environment is a
// dedicated runner.

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, type Json, sha256Hex } from '@supakernel/contracts'
import type { Environment } from './manifest.js'
import { bootstrapMedianCI, type CI, compareVerdict, summarize } from './stats.js'
import type { ValidationReport } from './validator.js'

export function captureEnvironment(): Environment {
  let governor: string | null = null
  try {
    governor =
      execSync('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null', {
        encoding: 'utf8',
      }).trim() || null
  } catch {
    governor = null
  }
  const dedicated = process.env.SUPAKERNEL_BENCH_DEDICATED === '1'
  return {
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    kernel: `${platform()} ${release()} ${arch()}`,
    totalMemBytes: totalmem(),
    node: process.version,
    governor,
    dedicated,
    note: dedicated
      ? 'dedicated performance runner'
      : 'SHARED runner — cold-start / warm numbers are recorded as evidence; no "faster than BKND" claim is made (contract §23)',
  }
}

export interface MetricSamples {
  readonly name: string
  readonly unit: string
  readonly a: readonly number[]
  readonly b: readonly number[]
}

export interface BenchReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly git: { sha: string; dirty: boolean }
  readonly systems: { a: string; b: string }
  readonly environment: Environment
  readonly validation: ValidationReport
  readonly metrics: readonly {
    name: string
    unit: string
    a: { summary: ReturnType<typeof summarize>; ci: CI; raw: readonly number[] }
    b: { summary: ReturnType<typeof summarize>; ci: CI; raw: readonly number[] }
    verdict: string
    verdictReason: string
  }[]
  readonly claimAllowed: boolean
  readonly hash: string
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function buildReport(input: {
  a: string
  b: string
  validation: ValidationReport
  metrics: readonly MetricSamples[]
}): BenchReport {
  const environment = captureEnvironment()
  const metrics = input.metrics.map((m) => {
    const aci = bootstrapMedianCI(m.a)
    const bci = bootstrapMedianCI(m.b)
    const v = compareVerdict(aci, bci)
    return {
      name: m.name,
      unit: m.unit,
      a: { summary: summarize(m.a), ci: aci, raw: m.a },
      b: { summary: summarize(m.b), ci: bci, raw: m.b },
      verdict: environment.dedicated ? v.verdict : 'inconclusive',
      verdictReason: environment.dedicated
        ? v.reason
        : 'shared runner — no competitive verdict (§23)',
    }
  })
  const body = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    git: { sha: git('rev-parse HEAD'), dirty: git('status --porcelain').length > 0 },
    systems: { a: input.a, b: input.b },
    environment,
    validation: input.validation,
    metrics,
    claimAllowed: environment.dedicated && input.validation.ok,
  }
  return { ...body, hash: sha256Hex(canonicalJson(body as unknown as Json)) }
}

export function writeReport(root: string, report: BenchReport): { dir: string } {
  const dir = join(root, `bknd-${report.generatedAt.replace(/[:.]/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(dir, 'report.md'), toMarkdown(report))
  return { dir }
}

function toMarkdown(r: BenchReport): string {
  const lines = [
    `# Benchmark: ${r.systems.a} vs ${r.systems.b}`,
    '',
    `- generated: ${r.generatedAt}`,
    `- git: ${r.git.sha}${r.git.dirty ? ' (dirty)' : ''}`,
    `- environment: ${r.environment.cpuModel}, ${r.environment.cores} cores, ${r.environment.kernel}, node ${r.environment.node}`,
    `- governor: ${r.environment.governor ?? 'n/a'} · dedicated: ${r.environment.dedicated}`,
    `- **${r.environment.note}**`,
    '',
    '## Validator (capability intersection)',
    '',
    `- result: ${r.validation.ok ? 'PASS' : 'FAIL'} · durability equivalent: ${r.validation.durabilityOk}`,
    `- durability: \`${JSON.stringify(r.validation.durability)}\``,
    r.validation.issues.length
      ? `- issues: ${r.validation.issues.map((i) => `${i.op}/${i.field}`).join(', ')}`
      : '- issues: none',
    '',
    '## Metrics',
    '',
    '| metric | A p50 | A 95% CI | B p50 | B 95% CI | verdict |',
    '|---|---|---|---|---|---|',
    ...r.metrics.map(
      (m) =>
        `| ${m.name} (${m.unit}) | ${m.a.summary.p50.toFixed(2)} | [${m.a.ci.lo.toFixed(2)}, ${m.a.ci.hi.toFixed(2)}] | ${m.b.summary.p50.toFixed(2)} | [${m.b.ci.lo.toFixed(2)}, ${m.b.ci.hi.toFixed(2)}] | ${m.verdict} — ${m.verdictReason} |`,
    ),
    '',
    `claim permitted: **${r.claimAllowed}** (needs a dedicated runner + validator pass)`,
    `report hash: \`${r.hash}\``,
    '',
  ]
  return `${lines.join('\n')}\n`
}
