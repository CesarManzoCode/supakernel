/**
 * Node 24.20.0 runtime profile example (contract §10, §30 L10). Composes the kernel + gateway
 * against Postgres + the filesystem blob store and serves them over `node:http`, with the
 * Realtime endpoint attached via `ws`.
 *
 *   SUPAKERNEL_DATABASE_URL=postgres://… SUPAKERNEL_BLOB_ROOT=./blobs node dist/server.mjs
 */
import { openFsBlob } from '@supakernel/blob-fs'
import { openS3Blob } from '@supakernel/blob-s3'
import type { SchemaIR } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink, systemClock, webRandom } from '@supakernel/ports'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import {
  attachNodeRealtime,
  NODE_LIMITS,
  readRuntimeEnv,
  serveNode,
} from '@supakernel/runtime-node'
import schema from './schema.json' with { type: 'json' }

const env = readRuntimeEnv(process.env)

const kernel = await KernelInstance.create({
  projectRef: env.projectRef,
  serverSecret: env.serverSecret,
  runtime: 'node',
  adapter: openPostgres({ url: env.databaseUrl ?? 'postgres://localhost:5432/postgres' }),
  blob: env.s3
    ? openS3Blob({ ...env.s3, id: 'node-example' })
    : openFsBlob({ root: env.blobRoot ?? './blobs' }),
  schema: schema as SchemaIR,
  ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
  limits: NODE_LIMITS,
})
const app = createGateway({
  kernel,
  corsOrigins: env.corsOrigins,
  maxBodyBytes: NODE_LIMITS.maxRequestBodyBytes,
})

const server = await serveNode({
  fetch: (request) => app.fetch(request),
  port: env.port,
  host: env.host,
  onServer: (http) => {
    const conns = new Set<{
      conn: ReturnType<typeof kernel.realtimeConnection>
      send: (s: string) => void
    }>()
    attachNodeRealtime(http, {
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
    })
    setInterval(async () => {
      for (const ev of await kernel.dispatcher.pump()) {
        for (const { conn, send } of conns) {
          for (const f of conn.deliver(ev).frames) send(encodeFrame(f))
        }
      }
    }, 250).unref()
  },
})

process.stdout.write(`supakernel (node) listening on ${server.url}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await server.close()
    await kernel.dispose()
    process.exit(0)
  })
}
