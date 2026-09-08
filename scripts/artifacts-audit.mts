/**
 * `pnpm artifacts:audit` (contract §19.2, §26, §31). Every failure artifact must replay to
 * the same normalized hash three times, fully offline. This runs the offline replay over the
 * most recent conformance run.
 *
 *   node scripts/artifacts-audit.mts
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
const confRoot = join(root, 'artifacts', 'conformance')

if (!existsSync(confRoot)) {
  console.error('artifacts:audit: no artifacts/conformance/ — run `pnpm conformance:pr` first')
  process.exit(1)
}

const runs = readdirSync(confRoot)
  .map((d) => join(confRoot, d))
  .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'checksums.txt')))
  .sort()

if (runs.length === 0) {
  console.error('artifacts:audit: no complete conformance run found')
  process.exit(1)
}

let failed = false
for (const run of runs.slice(-3)) {
  process.stdout.write(`  replay ${run.replace(root, '.')} … `)
  try {
    execSync(`node labs/conformance/dist/cli.js replay ${run}`, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log('3/3 hash-identical')
  } catch (err) {
    failed = true
    console.log('DIVERGENT')
    const e = err as { stdout?: Buffer }
    console.log(String(e.stdout ?? '').slice(-2000))
  }
}

console.log(failed ? '\nartifacts:audit FAIL' : '\nartifacts:audit PASS')
process.exit(failed ? 1 : 0)
