// Discover the running Supabase-local stack, export SUPAKERNEL_CONF_SB_* and run a lab test
// file through vitest (contract §30 L12 commands: test:upgrade:local, fault:all).
//
//   node labs/faults/runtime/run.mjs test/upgrade.local.test.ts

import { spawnSync } from 'node:child_process'

const testPath = process.argv[2]
if (!testPath) {
  console.error('usage: node labs/faults/runtime/run.mjs <test-file>')
  process.exit(2)
}

const env = { ...process.env }
const workdir = process.env.SUPAKERNEL_CONF_SB_WORKDIR ?? '/tmp/claude-1000/sb-oracle'
const status = spawnSync('supabase', ['status', '-o', 'env', '--workdir', workdir], {
  encoding: 'utf8',
})
if (status.status === 0 && status.stdout) {
  const m = {}
  for (const line of status.stdout.split('\n')) {
    const mm = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)
    if (mm) m[mm[1]] = mm[2]
  }
  if (m.API_URL && m.DB_URL && m.ANON_KEY && m.SERVICE_ROLE_KEY) {
    env.SUPAKERNEL_CONF_SB_API_URL = m.API_URL
    env.SUPAKERNEL_CONF_SB_DB_URL = m.DB_URL
    env.SUPAKERNEL_CONF_SB_ANON_KEY = m.ANON_KEY
    env.SUPAKERNEL_CONF_SB_SERVICE_KEY = m.SERVICE_ROLE_KEY
    if (m.MAILPIT_URL || m.INBUCKET_URL)
      env.SUPAKERNEL_CONF_SB_MAILPIT_URL = m.MAILPIT_URL ?? m.INBUCKET_URL
    console.log(`faults: supabase-local at ${m.API_URL}`)
  }
}

const r = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--project', '@supakernel/lab-faults', `labs/faults/${testPath}`],
  { stdio: 'inherit', env },
)
process.exit(r.status ?? 1)
