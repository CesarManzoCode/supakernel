/**
 * Bun 1.4.1 runtime profile example (contract §10, §30 L10). Composes the kernel + gateway and
 * serves them through `Bun.serve` with native-WebSocket Realtime.
 *
 *   SUPAKERNEL_DATABASE_URL=postgres://… bun run server.ts
 */
import { openFsBlob } from '@supakernel/blob-fs'
import type { SchemaIR } from '@supakernel/contracts'
import { openPglite } from '@supakernel/db-pglite'
import { openPostgres } from '@supakernel/db-postgres'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink, systemClock, webRandom } from '@supakernel/ports'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import { BUN_LIMITS, readRuntimeEnv, serveBun } from '@supakernel/runtime-bun'
import schema from './schema.json' with { type: 'json' }

const env = readRuntimeEnv(process.env)

const kernel = await KernelInstance.create({
  projectRef: env.projectRef,
  serverSecret: env.serverSecret,
  runtime: 'bun',
  adapter: env.databaseUrl
    ? openPostgres({ url: env.databaseUrl })
    : openPglite({ dataDir: env.blobRoot ? `${env.blobRoot}/pg` : 'memory://' }),
  blob: openFsBlob({ root: env.blobRoot ?? './blobs' }),
  schema: schema as SchemaIR,
  ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
  limits: BUN_LIMITS,
})
const app = createGateway({ kernel, maxBodyBytes: BUN_LIMITS.maxRequestBodyBytes })

const conns = new Set<{
  conn: ReturnType<typeof kernel.realtimeConnection>
  send: (s: string) => void
}>()
const server = serveBun({
  fetch: (request) => app.fetch(request),
  port: env.port,
  host: env.host,
  realtime: {
    path: '/realtime/v1',
    handle: (socket) => {
      const conn = kernel.realtimeConnection({
        kind: 'anonymous',
        subjectId: null,
        tenantId: env.projectRef,
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
setInterval(async () => {
  for (const ev of await kernel.dispatcher.pump()) {
    for (const { conn, send } of conns)
      for (const f of conn.deliver(ev).frames) send(encodeFrame(f))
  }
}, 250)

process.stdout.write(`supakernel (bun) listening on ${server.url}\n`)
