// Lane launcher (contract §30 L11). Discovers the running Supabase-local oracle, exports its
// URL/keys as SUPAKERNEL_CONF_SB_*, and runs the conformance lane as a vitest project so the
// same TS/resolution pipeline every other gate uses applies. Artifacts land in
// artifacts/conformance/<run-id>/.
//
//   node labs/conformance/runtime/conformance.mjs pr
//   node labs/conformance/runtime/conformance.mjs --capability data
//   node labs/conformance/runtime/conformance.mjs nightly

import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
let lane = 'pr'
let capability = ''
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === 'pr' || a === 'nightly') lane = a
  else if (a === '--lane') lane = argv[++i] ?? lane
  else if (a === '--capability' || a === 'capability') capability = argv[++i] ?? ''
}

const env = { ...process.env, SUPAKERNEL_CONF_LANE: lane }
if (capability) env.SUPAKERNEL_CONF_CAPABILITY = capability

// Discover the Supabase-local stack. `supabase status -o env` prints shell assignments.
const workdir = process.env.SUPAKERNEL_CONF_SB_WORKDIR ?? '/tmp/claude-1000/sb-oracle'
const status = spawnSync('supabase', ['status', '-o', 'env', '--workdir', workdir], {
  encoding: 'utf8',
  env: { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST ?? '' },
})
if (status.status === 0 && status.stdout) {
  const map = {}
  for (const line of status.stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)
    if (m) map[m[1]] = m[2]
  }
  const api = map.API_URL
  const db = map.DB_URL
  const anon = map.ANON_KEY
  const service = map.SERVICE_ROLE_KEY
  if (api && db && anon && service) {
    env.SUPAKERNEL_CONF_SB_API_URL = api
    env.SUPAKERNEL_CONF_SB_DB_URL = db
    env.SUPAKERNEL_CONF_SB_ANON_KEY = anon
    env.SUPAKERNEL_CONF_SB_SERVICE_KEY = service
    if (map.MAILPIT_URL || map.INBUCKET_URL) {
      env.SUPAKERNEL_CONF_SB_MAILPIT_URL = map.MAILPIT_URL ?? map.INBUCKET_URL
    }
    console.log(`conformance: supabase-local oracle at ${api}`)
  } else {
    console.warn('conformance: `supabase status` did not report a full oracle config')
  }
} else {
  console.warn(
    'conformance: supabase-local not reachable via `supabase status`; the lane will fail the mandatory-target check',
  )
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--project',
    '@supakernel/lab-conformance',
    'labs/conformance/test/lane.test.ts',
  ],
  { stdio: 'inherit', env },
)
process.exit(result.status ?? 1)
