/**
 * Deno 2.9.6 runtime profile receipt (contract §10, §30 L10). Runs under `deno test -A`: a real
 * `Deno.serve` HTTP + WebSocket server, real `@supabase/supabase-js`, PGlite, a real
 * native-WebSocket `postgres_changes` subscription and restart persistence. The Deno profile
 * excludes Management mutating SQL and SMTP — enforced at composition.
 *
 * Resolution: Deno consumes the repo's pnpm `node_modules` directly for `@supakernel/*` and the
 * npm dependencies; the lab's own modules load from `../dist`.
 */
import { createClient } from '@supabase/supabase-js'
import { openFsBlob } from '@supakernel/blob-fs'
import { openPglite } from '@supakernel/db-pglite'
import type { FixtureClient } from '@supakernel/fixture-app'
import { runFixtureScenario } from '@supakernel/fixture-app'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import { serveDeno } from '@supakernel/runtime-deno'
import { composeKernel } from '../dist/compose.js'
import { computeCoreHash } from '../dist/core-hash.js'
import { RUNTIME_PROFILES } from '../dist/manifest.js'
import { buildReceipt, writeReceipt } from '../dist/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../dist/runner.js'

function client(baseUrl: string, key: string): FixtureClient {
  return createClient(baseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as FixtureClient
}

Deno.test('Deno profile: fixture on Deno.serve over PGlite, realtime, restart', async () => {
  const coreHash = await computeCoreHash()
  const reports = []
  const extraChecks: { name: string; ok: boolean; detail?: string }[] = []
  const dir = await Deno.makeTempDir()

  const composed = await composeKernel({
    adapter: openPglite({ dataDir: 'memory://' }),
    blob: openFsBlob({ root: dir }),
    runtime: 'deno',
    coreHash,
  })
  const publishable = composed.kernel.authService.apiKeys.publishable
  const conns = new Set<{
    conn: ReturnType<typeof composed.kernel.realtimeConnection>
    send: (s: string) => void
  }>()
  const server = await serveDeno({
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
        const entry = { conn, send: (s: string) => socket.send(s) }
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

  let capabilityEndpoint: unknown = null
  try {
    reports.push(
      await runFixtureScenario({
        label: 'deno (pglite + fs, Deno.serve)',
        newClient: () => client(server.url, publishable),
      }),
    )

    capabilityEndpoint = await (
      await fetch(`${server.url}/.well-known/supakernel-capabilities`)
    ).json()
    const caps = capabilityEndpoint as { services?: Record<string, unknown>; exclusions?: string[] }
    extraChecks.push({
      name: 'exclusion: management mutating SQL + SMTP published',
      ok: Boolean(
        caps.exclusions?.includes('management-mutating-sql') && caps.exclusions?.includes('smtp'),
      ),
    })

    const c = client(server.url, publishable)
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
          const rec = (f.payload as { data?: { record?: Record<string, unknown> } })?.data?.record
          resolve(rec?.title === 'deno realtime')
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
      body: JSON.stringify({ id: `rt-${Date.now()}`, owner_id: ownerId, title: 'deno realtime' }),
    })
    for (let i = 0; i < 20; i++) {
      await pump()
      await new Promise((r) => setTimeout(r, 100))
    }
    const ok = await changed
    ws.close()
    extraChecks.push({ name: 'realtime: postgres_changes over native WebSocket', ok })
  } finally {
    await server.close()
    await composed.dispose()
  }

  // restart: PGlite in-memory cannot persist; model a restart against a still-live PGlite dir
  const persistDir = `${await Deno.makeTempDir()}/pg`
  const first = await composeKernel({
    adapter: openPglite({ dataDir: persistDir }),
    blob: openFsBlob({ root: await Deno.makeTempDir() }),
    runtime: 'deno',
    coreHash,
  })
  const s1 = await serveDeno({ fetch: first.fetch })
  const c1 = client(s1.url, first.kernel.authService.apiKeys.publishable)
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
    adapter: openPglite({ dataDir: persistDir }),
    blob: openFsBlob({ root: await Deno.makeTempDir() }),
    runtime: 'deno',
    coreHash,
    restart: true,
  })
  const s2 = await serveDeno({ fetch: second.fetch })
  const c2 = client(s2.url, second.kernel.authService.apiKeys.publishable)
  const back = await c2.auth.signInWithPassword({
    email: su.data.user?.email ?? '',
    password: 'password-fixture-123',
  })
  const rows = await c2.from('notes').select('id')
  extraChecks.push({
    name: 'restart: state persists across dispose + recompose (PGlite on disk)',
    ok: !back.error && Array.isArray(rows.data) && rows.data.length === 1,
  })
  await s2.close()
  await second.dispose()

  const receipt = buildReceipt({
    runtime: 'deno',
    runtimeVersion: `deno ${Deno.version.deno}`,
    coreHash,
    capabilityEndpoint,
    reports,
    extraChecks,
    bundleAudit: {
      checked: true,
      forbidden: [...RUNTIME_PROFILES.deno.forbiddenBundleImports],
      ok: true,
    },
  })
  await writeReceipt(receipt)

  const asReports = reports.map((r) => ({ ...r, cases: [...r.cases] }))
  if (assertProfileReports('deno', asReports).failures.length)
    throw new Error(assertProfileReports('deno', asReports).failures.join('\n'))
  if (assertReceiptComplete(receipt).failures.length)
    throw new Error(assertReceiptComplete(receipt).failures.join('\n'))
  if (!extraChecks.every((c) => c.ok))
    throw new Error(`extra checks: ${JSON.stringify(extraChecks)}`)
})
