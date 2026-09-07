/**
 * First-party Cloudflare Workers conformance worker for the L10 runtime profile (contract §10,
 * §30 L10 — "actual … workerd", "no faked socket"). Wrangler bundles this; it runs on real
 * workerd with real local D1 + R2. It composes the kernel + gateway with D1 as the database and
 * R2 as the blob store, and serves the Realtime endpoint through a real `WebSocketPair`.
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

const SCHEMA: SchemaIR = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'owner_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'title', type: 'text', nullable: false, default: null, generated: false },
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [],
    },
  ],
  sequences: [],
  policies: [],
}

const ownerEqSubject = {
  kind: 'compare' as const,
  op: 'eq' as const,
  left: { kind: 'column' as const, table: 'notes', name: 'owner_id' },
  right: { kind: 'context' as const, name: 'subjectId' as const },
}
const fields = { read: '*' as const, write: '*' as const, immutable: ['id'] }
const POLICIES = [
  {
    id: 'sel',
    table: 'notes',
    action: 'select' as const,
    role: 'authenticated',
    mode: 'permissive' as const,
    using: ownerEqSubject,
    check: null,
    fields,
  },
  {
    id: 'ins',
    table: 'notes',
    action: 'insert' as const,
    role: 'authenticated',
    mode: 'permissive' as const,
    using: null,
    check: ownerEqSubject,
    fields,
  },
  {
    id: 'upd',
    table: 'notes',
    action: 'update' as const,
    role: 'authenticated',
    mode: 'permissive' as const,
    using: ownerEqSubject,
    check: ownerEqSubject,
    fields,
  },
  {
    id: 'del',
    table: 'notes',
    action: 'delete' as const,
    role: 'authenticated',
    mode: 'permissive' as const,
    using: ownerEqSubject,
    check: null,
    fields,
  },
]

interface Booted {
  kernel: KernelInstance
  fetch: (request: Request) => Promise<Response>
}

let booted: Promise<Booted> | undefined

async function boot(env: WorkersEnv): Promise<Booted> {
  const cfg = readWorkersConfig(env)
  const adapter = openD1({ binding: env.DB })
  await adapter
    .execute({
      text: 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL)',
      parameters: [],
    })
    .catch(() => undefined)
  const kernel = await KernelInstance.create({
    projectRef: cfg.projectRef,
    serverSecret: cfg.serverSecret,
    runtime: 'workers',
    adapter,
    blob: openR2Blob({ bucket: env.BUCKET }),
    schema: { ...SCHEMA, policies: POLICIES },
    policies: POLICIES,
    ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
    limits: WORKERS_LIMITS,
    services: ['data', 'auth', 'storage', 'realtime'],
    exclusions: ['management-raw-sql', 'smtp', 'filesystem'],
    management: { token: cfg.managementToken ?? 'sk_mgmt_workers', queryEnabled: false },
    ...(cfg.coreHash ? { coreHash: cfg.coreHash } : {}),
  })
  const app = createGateway({ kernel, maxBodyBytes: WORKERS_LIMITS.maxRequestBodyBytes })
  return { kernel, fetch: (request) => app.fetch(request) }
}

const ANON = {
  kind: 'anonymous' as const,
  subjectId: null,
  tenantId: 'local',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none' as const,
}

export default {
  async fetch(request: Request, env: WorkersEnv, ctx: ExecutionContext): Promise<Response> {
    booted ??= boot(env)
    const { kernel, fetch } = await booted
    const url = new URL(request.url)

    if (url.pathname === '/_harness/notes') {
      const rows = await kernel.authService.db.adapter.execute({
        text: 'SELECT id, owner_id, title FROM notes',
        parameters: [],
      })
      return Response.json(rows.rows)
    }

    if (url.pathname === '/_harness/keys') {
      // The harness needs the randomly-minted publishable key to drive supabase-js. This
      // endpoint exists only in the labs conformance worker, never in @supakernel/runtime-workers.
      return Response.json({ publishable: kernel.authService.apiKeys.publishable })
    }

    if (url.pathname === '/realtime/v1/websocket') {
      const { response, socket } = upgradeWorkersRealtime()
      const conn = kernel.realtimeConnection(ANON)
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
          for (let i = 0; i < 400 && open; i++) {
            for (const ev of await kernel.dispatcher.pump()) {
              for (const f of conn.deliver(ev).frames) socket.send(encodeFrame(f))
            }
            await new Promise((r) => setTimeout(r, 100))
          }
        })(),
      )
      return response
    }

    return fetch(request)
  },
}
