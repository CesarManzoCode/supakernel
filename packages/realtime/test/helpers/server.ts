import { type AddressInfo, createServer, type Server } from 'node:http'
import { createWebCryptoPort, generateSigningKey } from '@supakernel/auth'
import type { Family, PolicyRule, Principal, SchemaIR } from '@supakernel/contracts'
import { sql } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import type { DatabaseAdapter } from '@supakernel/ports'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  decodeFrame,
  encodeFrame,
  OutboxDispatcher,
  type Outgoing,
  outboxSchemaStatements,
  outboxTriggerStatements,
  RealtimeConnection,
} from '../../src/index.js'

const A: Principal = {
  kind: 'user',
  subjectId: 'user-a',
  tenantId: 'demo',
  role: 'authenticated',
  sessionId: 's',
  claims: { sub: 'user-a' },
  credentialSource: 'jwt',
}
const ANON: Principal = {
  kind: 'anonymous',
  subjectId: null,
  tenantId: 'demo',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none',
}
export const SEATS = { A, ANON }

export interface RealtimeHarness {
  url: string
  adapter: DatabaseAdapter
  dispatcher: OutboxDispatcher
  crypto: Awaited<ReturnType<typeof createWebCryptoPort>>
  signToken(claims: Record<string, unknown>): Promise<string>
  pump(): Promise<number>
  connections: number
  close(): Promise<void>
}

export async function makeRealtimeHarness(opts: {
  family: Family
  schema: SchemaIR
  policies?: readonly PolicyRule[]
  managedTables: Array<{ name: string; columns: string[]; primaryKey: string[] }>
  installTriggers?: boolean
  ddl: string[]
}): Promise<RealtimeHarness> {
  const adapter: DatabaseAdapter =
    opts.family === 'postgres'
      ? openPostgres({ url: process.env.SUPAKERNEL_TEST_PG_URL as string })
      : openNodeSqlite({ path: ':memory:' })

  for (const stmt of opts.ddl) await adapter.execute(sql(stmt))
  for (const stmt of outboxSchemaStatements(opts.family)) await adapter.execute(sql(stmt))
  if (opts.installTriggers !== false) {
    for (const t of opts.managedTables) {
      for (const stmt of outboxTriggerStatements(opts.family, t)) await adapter.execute(sql(stmt))
    }
  }

  const key = await generateSigningKey('rt-1')
  const crypto = await createWebCryptoPort([key])
  const dispatcher = new OutboxDispatcher(adapter, opts.family)

  const connCfg = {
    schema: opts.schema,
    policies: opts.policies ?? [],
    issuer: 'https://demo.supakernel',
    audience: 'authenticated',
    now: () => new Date().toISOString(),
    epochMillis: () => Date.now(),
    anonPrincipal: ANON,
    verifyToken: async (token: string): Promise<Principal | null> => {
      const r = await crypto.verifyJwt(token, {
        issuer: 'https://demo.supakernel',
        audience: 'authenticated',
        algorithms: ['ES256'],
      })
      if (!r.ok) return null
      const c = r.claims as Record<string, unknown>
      return {
        kind: 'user',
        subjectId: String(c.sub),
        tenantId: 'demo',
        role: String(c.role ?? 'authenticated'),
        sessionId: null,
        claims: c as never,
        credentialSource: 'jwt',
      }
    },
  }

  const http: Server = createServer()
  const wss = new WebSocketServer({ server: http, path: '/websocket' })
  const conns = new Map<WebSocket, RealtimeConnection>()

  wss.on('connection', (ws, req) => {
    const apikey = new URL(req.url ?? '', 'http://x').searchParams.get('apikey') ?? ''
    const principal = apikey === 'A' ? A : ANON
    const conn = new RealtimeConnection(connCfg, principal)
    conns.set(ws, conn)
    ws.on('message', async (raw) => {
      let out: Outgoing
      try {
        out = await conn.handleFrame(decodeFrame(String(raw)))
      } catch {
        return
      }
      for (const f of out.frames) ws.send(encodeFrame(f))
      if (out.close) ws.close(out.close.code, out.close.reason)
    })
    const timer = setInterval(() => {
      const t = conn.tick()
      for (const f of t.frames) ws.send(encodeFrame(f))
    }, 250)
    ws.on('close', () => {
      clearInterval(timer)
      conns.delete(ws)
    })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as AddressInfo).port

  const pump = async (): Promise<number> => {
    const events = await dispatcher.pump()
    for (const ev of events) {
      for (const [ws, conn] of conns) {
        const out = conn.deliver(ev)
        for (const f of out.frames) ws.send(encodeFrame(f))
        if (out.close) ws.close(out.close.code, out.close.reason)
      }
    }
    return events.length
  }

  return {
    url: `ws://127.0.0.1:${port}`,
    adapter,
    dispatcher,
    crypto,
    signToken: (claims) =>
      crypto.signJwt(
        {
          iss: 'https://demo.supakernel',
          aud: 'authenticated',
          role: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...claims,
        },
        'rt-1',
      ),
    pump,
    get connections() {
      return conns.size
    },
    close: async () => {
      for (const ws of conns.keys()) ws.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
      await new Promise<void>((r) => http.close(() => r()))
      await adapter.close()
    },
  }
}
