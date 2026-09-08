// `mutation:critical` (contract §21, §30 L12).
//
// The BINDING gate is the manual critical-mutant catalog (contract §21 gate 1 + Appendix A —
// "critical semantic mutants y survivors explicados son evidencia más fuerte" than a global
// percentage; a global mutation percentage is explicitly rejected). That runs first and must
// be 100% green.
//
// Stryker (gate 2 — zero UNCLASSIFIED survivors in changed critical code) then runs over the
// critical modules. Survivors are triaged against equivalent-mutants.json (two-person review
// + AST diff). Score + timeouts are published to artifacts/mutation/stryker.json.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

function run(cmd, args) {
  return spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', FORCE_COLOR: '1' },
  })
}

// 1. manual critical-mutant catalog — must be 100% green.
console.log('mutation:critical — step 1/2: manual semantic catalog\n')
const semantic = run('pnpm', [
  'exec',
  'vitest',
  'run',
  '--project',
  '@supakernel/policy',
  'test/semantic-mutants.test.ts',
  '--project',
  '@supakernel/lab-mutation',
  'labs/mutation/test/semantic-mutants.test.ts',
])
if ((semantic.status ?? 1) !== 0) {
  console.error(
    '\nmutation:critical FAILED: a manual semantic mutant survived (release impossible, §21)',
  )
  process.exit(1)
}

// 2. Stryker generative pass.
console.log('\nmutation:critical — step 2/2: Stryker over the critical modules\n')
const stryker = run('pnpm', [
  'exec',
  'stryker',
  'run',
  'labs/mutation/stryker.conf.json',
  ...process.argv.slice(2),
])

const reportPath = 'artifacts/mutation/stryker.json'
if (existsSync(reportPath)) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const equivalents = existsSync('labs/mutation/equivalent-mutants.json')
    ? new Set(
        JSON.parse(readFileSync('labs/mutation/equivalent-mutants.json', 'utf8')).map((e) => e.id),
      )
    : new Set()
  let total = 0
  let killed = 0
  const survivors = []
  const timeouts = []
  for (const file of Object.values(report.files ?? {})) {
    for (const m of file.mutants ?? []) {
      total += 1
      if (m.status === 'Killed') killed += 1
      if (m.status === 'Survived' && !equivalents.has(m.id)) survivors.push(m)
      if (m.status === 'Timeout') timeouts.push(m)
    }
  }
  const executed = killed + survivors.length + timeouts.length > 0 && killed > 0
  console.log(
    `\nStryker: ${killed}/${total} killed, ${survivors.length} unclassified survivor(s), ${timeouts.length} timeout(s)`,
  )
  if (!executed) {
    console.error(
      '\nStryker executed 0 tests per mutant in this environment (a known @stryker-mutator/vitest-runner + vitest 5 + pnpm project-refs incompatibility). ' +
        'The manual critical-mutant catalog (step 1, green) is the binding §21 gate; the Stryker generative pass is not asserted here until the runner integration is fixed.',
    )
    process.exit(2)
  }
  if (survivors.length > 0 || timeouts.length > 0) {
    for (const s of survivors.slice(0, 20))
      console.log(`  SURVIVOR ${s.id} ${s.mutatorName} @ ${s.location?.start?.line}`)
    for (const t of timeouts.slice(0, 20)) console.log(`  TIMEOUT  ${t.id} ${t.mutatorName}`)
    process.exit(1)
  }
}

process.exit(stryker.status ?? 0)
