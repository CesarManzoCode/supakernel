// Offline artifact replay (contract §19.2, §26). Recomputes the normalized hash of a stored
// run directory with no network and no client library, and asserts three passes are
// byte-identical.

import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { replayScenarioDir, verifyChecksums } from './artifact.js'

export interface ReplayResult {
  readonly runDir: string
  readonly perPass: readonly Record<string, Record<string, string>>[]
  readonly hashIdentical: boolean
  readonly checksumOk: boolean
  readonly checksumMismatches: readonly string[]
}

function replayAll(dirs: readonly string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const dir of dirs) {
    const { scenario, perTarget } = replayScenarioDir(dir)
    out[scenario] = perTarget
  }
  return out
}

/** Replay an artifact directory (a run dir, or a single scenario dir) three times offline. */
export function replay(artifactPath: string, passes = 3): ReplayResult {
  const st = statSync(artifactPath)
  const isScenarioDir = st.isDirectory() && artifactPath.includes(`${join('scenarios')}${'/'}`)
  const runDir = isScenarioDir ? dirname(dirname(artifactPath)) : artifactPath
  const checks = verifyChecksums(runDir)
  const scenariosDir = join(runDir, 'scenarios')
  const dirs = isScenarioDir
    ? [artifactPath]
    : readdirSync(scenariosDir).map((d) => join(scenariosDir, d))

  const perPass: Record<string, Record<string, string>>[] = []
  for (let i = 0; i < passes; i++) perPass.push(replayAll(dirs))
  const first = JSON.stringify(perPass[0])
  const hashIdentical = perPass.every((p) => JSON.stringify(p) === first)

  return {
    runDir,
    perPass,
    hashIdentical,
    checksumOk: checks.ok,
    checksumMismatches: checks.mismatches,
  }
}
