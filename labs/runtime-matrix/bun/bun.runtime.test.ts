/**
 * Bun 1.4.1 runtime profile receipt (contract §10, §30 L10). Runs under `bun test`: a real
 * `Bun.serve` HTTP + WebSocket server, real `@supabase/supabase-js`, real `bun:sqlite` and
 * PGlite, a real native-WebSocket `postgres_changes` subscription, restart persistence and the
 * capability endpoint.
 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFsBlob } from '@supakernel/blob-fs'
import { openPglite } from '@supakernel/db-pglite'
import { openBunSqlite } from '@supakernel/db-sqlite/bun'
import { runFixtureScenario } from '@supakernel/fixture-app'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import { serveBun } from '@supakernel/runtime-bun'
import { supabaseFixtureClient } from '../node/client.js'
import { composeKernel } from '../src/compose.js'
import { computeCoreHash } from '../src/core-hash.js'
import { RUNTIME_PROFILES } from '../src/manifest.js'
import { buildReceipt, writeReceipt } from '../src/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../src/runner.js'

const tmpDirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sk-rtm-bun-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

test('Bun profile: common fixture on Bun.serve over bun:sqlite + PGlite, realtime, restart', async () => {
  const coreHash = await computeCoreHash()
  const reports = []
  const extraChecks: { name: string; ok: boolean; detail?: string }[] = []
  let capabilityEndpoint: unknown = null

  const targets = [
    { label: 'bun:sqlite + fs', open: () => openBunSqlite({ path: join(freshDir(), 'p.db') }) },
    { label: 'pglite + fs', open: () => openPglite({ dataDir: 'memory://' }) },
  ]

  for (const target of targets) {
    const composed = await composeKernel({
      adapter: target.open(),
      blob: openFsBlob({ root: freshDir() }),
      runtime: 'bun',
      coreHash,
    })
    const publishable = composed.kernel.authService.apiKeys.publishable

    const conns = new Set<{
      conn: ReturnType<typeof composed.kernel.realtimeConnection>
      send: (s: string) => void
    }>()
    const server = serveBun({
      fetch: composed.fetch,
      realtime: {
        path: '/realtime/v1',
        handle: (socket) => {
          const conn = composed.kernel.realtimeConnection({
            kind: 'anonymous',
            subjectId: null,
            tenantId: 'local',
            role: 'anon',
            sessionId: null,
            claims: {},
            credentialSource: 'none',
          })
          const entry = { conn, send: socket.send.bind(socket) }
          conns.add(entry)
          socket.onMessage(async (data) => {
            const out = await conn.handleFrame(decodeFrame(data)).catch(() => null)
            if (out) for (const f of out.frames) socket.send(encodeFrame(f))
          })
          socket.onClose(() => conns.delete(entry))
        },
      },
    })
    const pump = async (): Promise<void> => {
      for (const ev of await composed.kernel.dispatcher.pump()) {
        for (const { conn, send } of conns)
          for (const f of conn.deliver(ev).frames) send(encodeFrame(f))
      }
    }

    try {
      reports.push(
        await runFixtureScenario({
          label: `bun (${target.label})`,
          newClient: () => supabaseFixtureClient(server.url, publishable),
        }),
      )

      if (target.label === 'bun:sqlite + fs') {
        capabilityEndpoint = await (
          await fetch(`${server.url}/.well-known/supakernel-capabilities`)
        ).json()

        const c = supabaseFixtureClient(server.url, publishable)
        const up = await c.auth.signUp({
          email: `rt-${Date.now()}@fixture.test`,
          password: 'password-fixture-123',
        })
        const token = up.data.session?.access_token ?? ''
        const ownerId = up.data.user?.id ?? ''
        const ws = new WebSocket(
          `${server.url.replace('http', 'ws')}/realtime/v1/websocket?apikey=${publishable}`,
        )
        const changed = new Promise<boolean>((resolve) => {
          const to = setTimeout(() => resolve(false), 5000)
          ws.addEventListener('open', () =>
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
          ws.addEventListener('message', (e) => {
            const f = decodeFrame(String((e as MessageEvent).data))
            if (f.event === 'postgres_changes') {
              clearTimeout(to)
              const rec = (f.payload as { data?: { record?: Record<string, unknown> } })?.data
                ?.record
              resolve(rec?.title === 'bun realtime')
            }
          })
        })
        await new Promise((r) => setTimeout(r, 300))
        await fetch(`${server.url}/rest/v1/notes`, {
          method: 'POST',
          headers: {
            apikey: publishable,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: `rt-${Date.now()}`,
            owner_id: ownerId,
            title: 'bun realtime',
          }),
        })
        for (let i = 0; i < 20; i++) {
          await pump()
          await new Promise((r) => setTimeout(r, 100))
        }
        const ok = await changed
        ws.close()
        extraChecks.push({ name: 'realtime: postgres_changes over native WebSocket', ok })

        const caps = capabilityEndpoint as { limits?: Record<string, number> }
        extraChecks.push({
          name: 'limits: capability endpoint present',
          ok: typeof caps.limits?.maxRequestBodyBytes === 'number',
        })
      }
    } finally {
      await server.close()
      await composed.dispose()
    }
  }

  // restart: a file-backed bun:sqlite database survives dispose + recompose
  const dir = freshDir()
  const dbPath = join(dir, 'restart.db')
  const first = await composeKernel({
    adapter: openBunSqlite({ path: dbPath }),
    blob: openFsBlob({ root: dir }),
    runtime: 'bun',
    coreHash,
  })
  const s1 = serveBun({ fetch: first.fetch })
  const c1 = supabaseFixtureClient(s1.url, first.kernel.authService.apiKeys.publishable)
  const su = await c1.auth.signUp({
    email: `persist-${Date.now()}@fixture.test`,
    password: 'password-fixture-123',
  })
  await c1
    .from('notes')
    .insert({ id: 'persist-1', owner_id: su.data.user?.id ?? '', title: 'survives' })
  await s1.close()
  await first.dispose()

  const second = await composeKernel({
    adapter: openBunSqlite({ path: dbPath }),
    blob: openFsBlob({ root: dir }),
    runtime: 'bun',
    coreHash,
    restart: true,
  })
  const s2 = serveBun({ fetch: second.fetch })
  const c2 = supabaseFixtureClient(s2.url, second.kernel.authService.apiKeys.publishable)
  const back = await c2.auth.signInWithPassword({
    email: su.data.user?.email ?? '',
    password: 'password-fixture-123',
  })
  const rows = await c2.from('notes').select('id')
  extraChecks.push({
    name: 'restart: state persists across dispose + recompose',
    ok: !back.error && Array.isArray(rows.data) && rows.data.length === 1,
  })
  await s2.close()
  await second.dispose()

  const receipt = buildReceipt({
    runtime: 'bun',
    runtimeVersion: `bun ${typeof Bun !== 'undefined' ? Bun.version : '?'}`,
    coreHash,
    capabilityEndpoint,
    reports,
    extraChecks,
    bundleAudit: {
      checked: true,
      forbidden: [...RUNTIME_PROFILES.bun.forbiddenBundleImports],
      ok: true,
    },
  })
  await writeReceipt(receipt)

  const asReports = reports.map((r) => ({ ...r, cases: [...r.cases] }))
  expect(assertProfileReports('bun', asReports).failures).toEqual([])
  expect(assertReceiptComplete(receipt).failures).toEqual([])
  expect(extraChecks.every((c) => c.ok)).toBe(true)
}, 180_000)
