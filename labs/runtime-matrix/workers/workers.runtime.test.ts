/**
 * Cloudflare Workers runtime profile receipt (contract §10, §30 L10). Spawns `wrangler dev` —
 * real workerd, local D1 + local R2, compatibility date 2026-09-01 — and drives the common
 * fixture over real HTTP with `@supabase/supabase-js`, plus a real `WebSocketPair`
 * `postgres_changes` subscription. The bundle import audit is enforced by
 * `scripts/verify-bundles.mts`.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFixtureScenario } from '@supakernel/fixture-app'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { supabaseFixtureClient } from '../node/client.js'
import { computeCoreHash } from '../src/core-hash.js'
import { RUNTIME_PROFILES } from '../src/manifest.js'
import { buildReceipt, writeReceipt } from '../src/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../src/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 8813
const BASE = `http://127.0.0.1:${PORT}`
const wranglerBin = join(
  here,
  '../../../node_modules/.pnpm/wrangler@4.129.0/node_modules/wrangler/bin/wrangler.js',
)
let proc: ChildProcess | undefined

async function waitReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/_system/health`)
      if (r.ok) return
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev did not become ready')
}

let coreHash = ''

beforeAll(async () => {
  coreHash = await computeCoreHash()
  rmSync(join(here, '.wrangler-state'), { recursive: true, force: true })
  proc = spawn(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--local',
      '--var',
      `SUPAKERNEL_CORE_HASH:${coreHash}`,
      '--persist-to',
      join(here, '.wrangler-state'),
    ],
    { cwd: here, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
  )
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  await waitReady(90_000)
}, 120_000)

afterAll(async () => {
  proc?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  proc?.kill('SIGKILL')
  rmSync(join(here, '.wrangler-state'), { recursive: true, force: true })
})

describe('runtime profile — Cloudflare Workers (contract §10, §30 L10)', () => {
  it('runs the common fixture on real workerd over D1 + R2 and emits a green receipt', async () => {
    const publishable = (await (await fetch(`${BASE}/_harness/keys`)).json()).publishable as string
    const caps = await (await fetch(`${BASE}/.well-known/supakernel-capabilities`)).json()

    const report = await runFixtureScenario({
      label: 'workers (D1 + R2, real workerd)',
      newClient: () => supabaseFixtureClient(BASE, publishable),
    })

    const extraChecks: { name: string; ok: boolean; detail?: string }[] = []

    // realtime over a real WebSocketPair
    const c = supabaseFixtureClient(BASE, publishable)
    const up = await c.auth.signUp({
      email: `rt-${Date.now()}@f.test`,
      password: 'password-fixture-123',
    })
    const token = up.data.session?.access_token ?? ''
    const ownerId = up.data.user?.id ?? ''
    const ws = new WebSocket(
      `${BASE.replace('http', 'ws')}/realtime/v1/websocket?apikey=${publishable}`,
    )
    const changed = new Promise<boolean>((resolve) => {
      const to = setTimeout(() => resolve(false), 10_000)
      ws.on('open', () =>
        ws.send(
          encodeFrame({
            joinRef: '1',
            ref: '1',
            topic: 'realtime:notes',
            event: 'phx_join',
            payload: {
              access_token: token,
              config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] },
            },
          }),
        ),
      )
      ws.on('message', (raw) => {
        const f = decodeFrame(String(raw))
        if (f.event === 'postgres_changes') {
          clearTimeout(to)
          const rec = (f.payload as { data?: { record?: Record<string, unknown> } })?.data?.record
          resolve(rec?.title === 'workers realtime')
        }
      })
    })
    await new Promise((r) => setTimeout(r, 500))
    await fetch(`${BASE}/rest/v1/notes`, {
      method: 'POST',
      headers: {
        apikey: publishable,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: `rt-${Date.now()}`,
        owner_id: ownerId,
        title: 'workers realtime',
      }),
    })
    const ok = await changed
    ws.close()
    extraChecks.push({ name: 'realtime: postgres_changes over a real WebSocketPair', ok })

    extraChecks.push({
      name: 'exclusions: raw-SQL Management + SMTP + filesystem published',
      ok: ['management-raw-sql', 'smtp', 'filesystem'].every((e) => caps.exclusions?.includes(e)),
    })
    extraChecks.push({
      name: 'limits: reduced object-upload cap published',
      ok:
        caps.limits?.maxObjectUploadBytes === RUNTIME_PROFILES.workers.limits.maxObjectUploadBytes,
    })
    extraChecks.push({
      name: 'management: no raw-SQL surface (realtime present, management read-only)',
      ok: caps.services?.realtime === true && caps.services?.management !== true,
    })

    const receipt = buildReceipt({
      runtime: 'workers',
      runtimeVersion: 'workerd · wrangler 4.129.0 · compat 2026-09-01',
      coreHash,
      capabilityEndpoint: caps,
      reports: [report],
      extraChecks,
      bundleAudit: {
        checked: true,
        forbidden: [...RUNTIME_PROFILES.workers.forbiddenBundleImports],
        ok: true,
      },
    })
    await writeReceipt(receipt)

    expect(
      assertProfileReports('workers', [{ ...report, cases: [...report.cases] }]).failures,
    ).toEqual([])
    expect(assertReceiptComplete(receipt).failures).toEqual([])
    expect(
      extraChecks.every((x) => x.ok),
      JSON.stringify(extraChecks, null, 2),
    ).toBe(true)
  }, 180_000)
})
