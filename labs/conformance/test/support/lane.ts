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
  writeArtifacts,
} from '../../src/index.js'
import { createKernelTarget } from './kernel-target.js'
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

function saveGolden(dir: string, id: string, normalized: Json): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(normalized, null, 2)}\n`)
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
  return { targets, oracleId: 'vendor.supabase-local' }
}

export async function runLane(opts: LaneOptions): Promise<LaneResult> {
  const startedAt = new Date().toISOString()
  const { targets, oracleId } = buildTargets()
  const scenarios: readonly ScenarioSpec[] = opts.capability
    ? scenariosByCapability(opts.capability)
    : scenariosForLane(opts.lane)
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
  })

  let oracleRan = false
  for (const report of summary.reports) {
    const oracle = report.results.find((r) => r.target === oracleId && !r.targetFailure)
    if (oracle) {
      oracleRan = true
      saveGolden(GOLDENS_DIR, report.scenario, oracle.normalized)
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
  if (!oracleRan && Object.keys(goldens).length === 0)
    missingMandatory.push('vendor.supabase-local')
  if (!process.env.SUPAKERNEL_TEST_PG_URL) missingMandatory.push('supakernel.pg')

  const ok =
    summary.totalBlocking === 0 && summary.totalUnclassified === 0 && missingMandatory.length === 0

  return { summary, artifactDir: dir, manifestHash, ok, oracleRan, missingMandatory }
}
