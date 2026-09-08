// `benchmark:run --systems bknd,supakernel` (contract §23, §30 L13). Boots both systems,
// validates the capability intersection, measures cold start (50 ABBA samples) + a warm
// request sequence, and writes a reproducible report to artifacts/benchmarks/.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReport,
  coldStart,
  supakernelClient,
  validate,
  WORKLOAD_OPS,
  warmSequence,
  writeReport,
} from '../dist/index.js'
import { bkndClient } from '../dist/systems.js'

const dbDir = mkdtempSync(join(tmpdir(), 'sk-bench-db-'))
const root = process.cwd()
const args = process.argv.slice(2)
const validateOnly = args.includes('--validate')

const SUPA = {
  id: 'supakernel',
  command: [process.execPath, join(root, 'labs/benchmarks/runtime/server-supakernel.mjs')],
  cwd: root,
  env: { PORT: '3212', BENCH_ROWS: '10000', BENCH_DB_URL: join(dbDir, 'supakernel.db') },
}
const BKND = {
  id: 'bknd',
  command: [process.execPath, join(root, 'labs/benchmarks/runtime/server-bknd.mjs')],
  cwd: join(root, 'labs/benchmarks'),
  env: { PORT: '3211', BENCH_ROWS: '10000', BENCH_DB_URL: join(dbDir, 'bknd.db') },
}

function boot(launcher) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command[0], launcher.command.slice(1), {
      cwd: launcher.cwd,
      env: { ...process.env, ...launcher.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let buf = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${launcher.id}: no READY in 60s`))
    }, 60_000)
    child.stdout.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/READY (\S+)(?: (\S+))?/)
      if (m) {
        clearTimeout(timer)
        resolve({ child, url: m[1], key: m[2] })
      }
    })
    child.on('exit', (c) => {
      clearTimeout(timer)
      reject(new Error(`${launcher.id}: exited ${c} before READY`))
    })
  })
}

async function main() {
  console.log('booting both systems (10k rows each)…')
  const [b, s] = await Promise.all([boot(BKND), boot(SUPA)])
  try {
    const bClient = bkndClient(b.url)
    const sClient = supakernelClient(s.url, s.key)

    console.log('validating capability intersection…')
    const validation = await validate(sClient, bClient, WORKLOAD_OPS)
    console.log(
      'validator:',
      validation.ok ? 'PASS' : 'FAIL',
      JSON.stringify(validation.durability),
    )
    if (!validation.ok) {
      console.log('issues:', JSON.stringify(validation.issues, null, 2))
    }

    if (validateOnly) {
      process.exitCode = validation.ok ? 0 : 1
      return
    }

    console.log('warm request sequence…')
    const warmPathsS = [
      `/rest/v1/todos?tenant_id=eq.t1&select=id`,
      `/rest/v1/todos?id=eq.42&select=id,tenant_id,body,done`,
    ]
    const warmPathsB = [
      `/api/data/entity/todos?where=${encodeURIComponent(JSON.stringify({ tenant_id: 't1' }))}&limit=1000`,
      `/api/data/entity/todos/42`,
    ]
    const warmA = await warmSequence(s.url, warmPathsS, 300)
    const warmB = await warmSequence(b.url, warmPathsB, 300)

    // free the ports for the cold-start reboots
    b.child.kill('SIGTERM')
    s.child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))

    console.log('cold start (50 ABBA samples/system)…')
    const cs = await coldStart(SUPA, BKND, 50)
    const csA = cs.filter((x) => x.system === 'supakernel').map((x) => x.ms)
    const csB = cs.filter((x) => x.system === 'bknd').map((x) => x.ms)

    const report = buildReport({
      a: 'supakernel',
      b: 'bknd',
      validation,
      metrics: [
        { name: 'cold-start', unit: 'ms', a: csA, b: csB },
        { name: 'warm-sequence', unit: 'ms', a: warmA, b: warmB },
      ],
    })
    const { dir } = writeReport(join(root, 'artifacts/benchmarks'), report)
    console.log(`\nreport: ${dir}`)
    console.log(`claim permitted: ${report.claimAllowed} · hash ${report.hash}`)
    process.exitCode = validation.ok ? 0 : 1
  } finally {
    b.child.kill('SIGTERM')
    s.child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
