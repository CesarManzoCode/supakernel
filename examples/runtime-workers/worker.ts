/**
 * Cloudflare Workers runtime profile example (contract §10, §30 L10). Data / Auth / Storage /
 * Realtime + health over D1 + R2. No filesystem, no SMTP, no raw-SQL Management. Realtime is a
 * real `WebSocketPair`. Bundle with `wrangler deploy` (or `scripts/verify-bundles.mts`).
 */
import { systemClock, webRandom } from '@supakernel/auth'
import type { SchemaIR } from '@supakernel/contracts'
import { openD1 } from '@supakernel/db-sqlite/d1'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink } from '@supakernel/ports'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import {
  openR2Blob,
  readWorkersConfig,
  upgradeWorkersRealtime,
  WORKERS_LIMITS,
  type WorkersEnv,
} from '@supakernel/runtime-workers'
import schema from './schema.json' with { type: 'json' }

let booted:
  | Promise<{ kernel: KernelInstance; fetch: (r: Request) => Promise<Response> }>
  | undefined

async function boot(env: WorkersEnv): Promise<{
  kernel: KernelInstance
  fetch: (r: Request) => Promise<Response>
}> {
  const cfg = readWorkersConfig(env)
  const kernel = await KernelInstance.create({
    projectRef: cfg.projectRef,
    serverSecret: cfg.serverSecret,
    runtime: 'workers',
    adapter: openD1({ binding: env.DB }),
    blob: openR2Blob({ bucket: env.BUCKET }),
    schema: schema as SchemaIR,
    ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
    limits: WORKERS_LIMITS,
    services: ['data', 'auth', 'storage', 'realtime'],
    exclusions: ['management-raw-sql', 'smtp', 'filesystem'],
    management: { queryEnabled: false, loopbackOnly: true },
    ...(cfg.coreHash ? { coreHash: cfg.coreHash } : {}),
  })
  const app = createGateway({ kernel, maxBodyBytes: WORKERS_LIMITS.maxRequestBodyBytes })
  return { kernel, fetch: (r) => app.fetch(r) }
}

export default {
  async fetch(request: Request, env: WorkersEnv, ctx: ExecutionContext): Promise<Response> {
    booted ??= boot(env)
    const { kernel, fetch } = await booted
    if (new URL(request.url).pathname === '/realtime/v1/websocket') {
      const { response, socket } = upgradeWorkersRealtime()
      const conn = kernel.realtimeConnection({
        kind: 'anonymous',
        subjectId: null,
        tenantId: 'local',
        role: 'anon',
        sessionId: null,
        claims: {},
        credentialSource: 'none',
      })
      let open = true
      socket.onMessage(async (data) => {
        const out = await conn.handleFrame(decodeFrame(data)).catch(() => null)
        if (out) for (const f of out.frames) socket.send(encodeFrame(f))
      })
      socket.onClose(() => {
        open = false
      })
      ctx.waitUntil(
        (async () => {
          while (open) {
            for (const ev of await kernel.dispatcher.pump()) {
              for (const f of conn.deliver(ev).frames) socket.send(encodeFrame(f))
            }
            await new Promise((r) => setTimeout(r, 150))
          }
        })(),
      )
      return response
    }
    return fetch(request)
  },
}
