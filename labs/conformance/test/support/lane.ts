// Test-support wiring: lane orchestration (contract §19, §30 L11 commands).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Json, ScenarioSpec } from '@supakernel/contracts'
import {
  ALL_SCENARIOS,
  DIVERGENCE_REGISTRY,
  type RunSummary,
  runConformance,
  scenariosByCapability,
  scenariosForLane,
  type Target,
  uniquifyScenarioTables,
  writeArtifacts,
} from '../../src/index.js'
import { createKernelTarget } from './kernel-target.js'
import { createSupabaseHostedTarget, createSupaliteTarget } from './opt-in-targets.js'
import { createRealtimeDriver } from './realtime-driver.js'
import { createSupabaseLocalTarget, supabaseLocalConfigFromEnv } from './supabase-local-target.js'

export const ARTIFACTS_ROOT = join(process.cwd(), 'artifacts', 'conformance')
export const GOLDENS_DIR = join(process.cwd(), 'labs', 'conformance', 'goldens')

export interface LaneOptions {
  readonly lane: 'pr' | 'nightly'
  readonly capability?: string
  readonly seed?: string
}

export interface LaneResult {
  readonly summary: RunSummary
  readonly artifactDir: string
  readonly manifestHash: string
  readonly ok: boolean
  readonly oracleRan: boolean
  readonly missingMandatory: readonly string[]
}

function loadGoldens(dir: string): Record<string, Json> {
  const out: Record<string, Json> = {}
  if (!existsSync(dir)) return out
  for (const s of ALL_SCENARIOS) {
    const p = join(dir, `${s.id}.json`)
    if (existsSync(p)) out[s.id] = JSON.parse(readFileSync(p, 'utf8')) as Json
  }
  return out
}

/** True when a realtime observation carries at least one change event. */
function realtimeObservationIsUseful(normalized: Json): boolean {
  const steps = (normalized as { steps?: { action?: string; body?: { events?: unknown } }[] })
    ?.steps
  if (!Array.isArray(steps)) return true // non-realtime scenarios are always fine to save
  const collects = steps.filter((s) => s.action === 'realtime.collect')
  if (collects.length === 0) return true
  return collects.some((s) => Array.isArray(s.body?.events) && s.body.events.length > 0)
}

function saveGolden(dir: string, id: string, normalized: Json): void {
  const p = join(dir, `${id}.json`)
  // Never regress a good realtime golden to an empty one: if the oracle flaked and observed
  // no events this run, keep the committed golden (contract §19.1).
  if (!realtimeObservationIsUseful(normalized) && existsSync(p)) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(p, `${JSON.stringify(normalized, null, 2)}\n`)
}

const TOOLCHAIN: Json = {
  node: process.version,
  supabaseCli: '2.116.0',
  supabaseJs: '2.115.0',
  postgres: '18.6 / vendor 17.6.1.165',
}

export function buildTargets(): { targets: Target[]; oracleId: string } {
  const targets: Target[] = []
  const sbCfg = supabaseLocalConfigFromEnv()
  if (sbCfg) targets.push(createSupabaseLocalTarget(sbCfg))
  targets.push(createKernelTarget('postgres'))
  targets.push(createKernelTarget('sqlite'))
  // Opt-in lanes: self-report unhealthy unless the owner enabled them, so the runner simply
  // omits them (contract §19.1, §32).
  targets.push(createSupabaseHostedTarget())
  targets.push(createSupaliteTarget())
  return { targets, oracleId: 'vendor.supabase-local' }
}

export async function runLane(opts: LaneOptions): Promise<LaneResult> {
  const startedAt = new Date().toISOString()
  const { targets, oracleId } = buildTargets()
  const baseScenarios: readonly ScenarioSpec[] = opts.capability
    ? scenariosByCapability(opts.capability)
    : scenariosForLane(opts.lane)
  // Per-run unique table names keep the oracle's schema-cache reload monotonic (see
  // uniquifyScenarioTables); the alias map normalizes them back so the golden and the
  // three-replay hashes stay stable.
  const runTag = Math.random().toString(36).slice(2, 8)
  const aliases: Record<string, Record<string, string>> = {}
  const scenarios: readonly ScenarioSpec[] = baseScenarios.map((s) => {
    const u = uniquifyScenarioTables(s, runTag)
    aliases[s.id] = { ...u.aliases }
    return { ...u.scenario, id: s.id }
  })
  const goldens = loadGoldens(GOLDENS_DIR)
  const seed = opts.seed ?? '0123456789abcdef0123456789abcdef'
  const runId = `${opts.lane}${opts.capability ? `-${opts.capability}` : ''}-${startedAt.replace(/[:.]/g, '-')}`

  const summary = await runConformance({
    targets,
    scenarios,
    registry: DIVERGENCE_REGISTRY,
    realtime: createRealtimeDriver(),
    oracleId,
    goldens,
    aliases,
  })

  const VENDOR_CAPS = new Set(['data', 'auth', 'storage', 'realtime'])
  let oracleRan = false
  let oracleExpectedButMissing = false
  for (const report of summary.reports) {
    const oracle = report.results.find((r) => r.target === oracleId && !r.targetFailure)
    if (oracle) {
      oracleRan = true
      saveGolden(GOLDENS_DIR, report.scenario, oracle.normalized)
    } else if (VENDOR_CAPS.has(report.capability)) {
      oracleExpectedButMissing = true
    }
  }

  const { dir, manifestHash } = writeArtifacts({
    root: ARTIFACTS_ROOT,
    runId,
    lane: opts.lane,
    seed,
    startedAt,
    scenarios,
    summary,
    toolchain: TOOLCHAIN,
  })

  const missingMandatory: string[] = []
  if (oracleExpectedButMissing && Object.keys(goldens).length === 0) {
    missingMandatory.push('vendor.supabase-local')
  }
  if (!process.env.SUPAKERNEL_TEST_PG_URL) missingMandatory.push('supakernel.pg')

  const ok =
    summary.totalBlocking === 0 && summary.totalUnclassified === 0 && missingMandatory.length === 0

  return { summary, artifactDir: dir, manifestHash, ok, oracleRan, missingMandatory }
}
