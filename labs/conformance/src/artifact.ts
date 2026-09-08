// Conformance artifacts (contract §19.2, §26). Every run writes an immutable, self-describing
// directory under `artifacts/conformance/<run-id>/` with a manifest, the scenario copy, raw
// and normalized observations per target, the diff, redacted logs, a replay command and a
// checksum file. `conformance:replay` reconstructs the normalized hash offline.

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release } from 'node:os'
import { join, relative } from 'node:path'
import type { Json, ScenarioSpec } from '@supakernel/contracts'
import { canonicalJson, sha256Hex } from '@supakernel/contracts'
import type { RunSummary, ScenarioReport } from './runner.js'

export interface RunManifest {
  readonly schemaVersion: 1
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly git: { readonly sha: string; readonly dirty: boolean }
  readonly host: {
    readonly platform: string
    readonly release: string
    readonly arch: string
    readonly cpu: string
  }
  readonly toolchain: Json
  readonly seed: string
  readonly lane: 'pr' | 'nightly'
  readonly scenarios: readonly string[]
  readonly summary: {
    readonly totalUnclassified: number
    readonly totalBlocking: number
    readonly byClass: Json
  }
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// Scrub secret-looking substrings inside string leaves only — the JSON structure is never
// touched, so redaction can never corrupt an artifact (contract §26 redaction audit).
const SECRET_SUBSTR_RE =
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|sb_secret_[A-Za-z0-9_-]+|sk_secret_[A-Za-z0-9_-]+/g
const SECRET_KEY_RE =
  /^(password|refresh_token|access_token|token|secret|apikey|api_key|serverSecret)$/i

function redactString(s: string): string {
  return s.replace(SECRET_SUBSTR_RE, '<redacted>')
}

export function redact(value: Json): Json {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v))
  if (value !== null && typeof value === 'object') {
    const out: { [k: string]: Json } = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '<redacted>' : redact(v as Json)
    }
    return out
  }
  return value
}

export interface WriteArtifactsInput {
  readonly root: string
  readonly runId: string
  readonly lane: 'pr' | 'nightly'
  readonly seed: string
  readonly startedAt: string
  readonly scenarios: readonly ScenarioSpec[]
  readonly summary: RunSummary
  readonly toolchain: Json
}

function writeJson(path: string, value: Json): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function checksumTree(dir: string, base: string): string[] {
  const lines: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      lines.push(...checksumTree(full, base))
    } else if (entry !== 'checksums.txt') {
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex')
      lines.push(`${hash}  ${relative(base, full)}`)
    }
  }
  return lines
}

export function writeArtifacts(input: WriteArtifactsInput): { dir: string; manifestHash: string } {
  const dir = join(input.root, input.runId)
  mkdirSync(dir, { recursive: true })

  const finishedAt = new Date().toISOString()
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt,
    git: { sha: git('rev-parse HEAD'), dirty: git('status --porcelain').length > 0 },
    host: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
    },
    toolchain: input.toolchain,
    seed: input.seed,
    lane: input.lane,
    scenarios: input.scenarios.map((s) => s.id),
    summary: {
      totalUnclassified: input.summary.totalUnclassified,
      totalBlocking: input.summary.totalBlocking,
      byClass: input.summary.byClass as unknown as Json,
    },
  }
  writeJson(join(dir, 'manifest.json'), manifest as unknown as Json)

  for (const scenario of input.scenarios) {
    const sdir = join(dir, 'scenarios', scenario.id)
    mkdirSync(sdir, { recursive: true })
    writeJson(join(sdir, 'scenario.json'), scenario as unknown as Json)
    const report = input.summary.reports.find((r) => r.scenario === scenario.id)
    if (!report) continue
    writeJson(join(sdir, 'report.json'), redact(report as unknown as Json))
    for (const result of report.results) {
      writeJson(
        join(sdir, `target.${result.target.replace(/[^a-z0-9.-]/gi, '_')}.json`),
        redact({
          target: result.target,
          normalized: result.normalized,
          normalizedHash: result.normalizedHash,
          rawHash: result.rawHash,
          targetFailure: result.targetFailure ?? null,
        } as unknown as Json),
      )
    }
    writeFileSync(
      join(sdir, 'replay.sh'),
      `#!/bin/sh\n# offline replay — no network\npnpm conformance:replay -- ${relative(process.cwd(), join(sdir))}\n`,
    )
  }

  const checksums = checksumTree(dir, dir).join('\n')
  writeFileSync(join(dir, 'checksums.txt'), `${checksums}\n`)

  return { dir, manifestHash: sha256Hex(canonicalJson(manifest as unknown as Json)) }
}

/** Recompute the normalized hash of a scenario artifact directory, fully offline. */
export function replayScenarioDir(sdir: string): {
  scenario: string
  perTarget: Record<string, string>
} {
  const perTarget: Record<string, string> = {}
  for (const entry of readdirSync(sdir)) {
    if (!entry.startsWith('target.') || !entry.endsWith('.json')) continue
    const parsed = JSON.parse(readFileSync(join(sdir, entry), 'utf8')) as {
      target: string
      normalized: Json
    }
    perTarget[parsed.target] = sha256Hex(canonicalJson(parsed.normalized))
  }
  const scenario = JSON.parse(readFileSync(join(sdir, 'scenario.json'), 'utf8')) as { id: string }
  return { scenario: scenario.id, perTarget }
}

export function verifyChecksums(runDir: string): { ok: boolean; mismatches: string[] } {
  const file = join(runDir, 'checksums.txt')
  const expected = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  const mismatches: string[] = []
  for (const line of expected) {
    const [hash, rel] = line.split(/\s\s+/)
    if (!hash || !rel) continue
    const actual = createHash('sha256')
      .update(readFileSync(join(runDir, rel)))
      .digest('hex')
    if (actual !== hash) mismatches.push(rel)
  }
  return { ok: mismatches.length === 0, mismatches }
}

export function summarizeReports(reports: readonly ScenarioReport[]): string {
  return reports
    .map((r) => {
      const parts = r.classifications.map(
        (c) => `${c.target}=${c.classification.class}${c.classification.blocking ? '!' : ''}`,
      )
      return `  ${r.capability}/${r.scenario} [oracle ${r.oracle}] ${parts.join(' ') || '(oracle only)'}`
    })
    .join('\n')
}
