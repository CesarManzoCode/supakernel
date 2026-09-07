import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { systemClock, webRandom } from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink } from '@supakernel/ports'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGateway } from '../src/index.js'

const SCHEMA = {
  version: 1 as const,
  tables: [
    {
      name: 'notes',
      columns: [
        {
          name: 'id',
          type: 'text' as const,
          nullable: false,
          default: { kind: 'uuidV4' as const },
          generated: false,
        },
        {
          name: 'owner_id',
          type: 'text' as const,
          nullable: false,
          default: null,
          generated: false,
        },
        { name: 'title', type: 'text' as const, nullable: false, default: null, generated: false },
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
const POLICIES = [
  {
    id: 's',
    table: 'notes',
    action: 'select' as const,
    role: 'authenticated',
    mode: 'permissive' as const,
    using: {
      kind: 'compare' as const,
      op: 'eq' as const,
      left: { kind: 'column' as const, table: 'notes', name: 'owner_id' },
      right: { kind: 'context' as const, name: 'subjectId' as const },
    },
    check: null,
    fields: { read: '*' as const, write: [], immutable: [] },
  },
  {
    id: 'i',
    table: 'notes',
    action: 'insert' as const,
    role: 'authenticated',
    mode: 'permissive' as const,
    using: null,
    check: {
      kind: 'compare' as const,
      op: 'eq' as const,
      left: { kind: 'column' as const, table: 'notes', name: 'owner_id' },
      right: { kind: 'context' as const, name: 'subjectId' as const },
    },
    fields: {
      read: '*' as const,
      write: ['owner_id', 'title'] as string[],
      immutable: ['id'] as string[],
    },
  },
]

describe('gateway — one Hono app, fixture flow via real @supabase/supabase-js (contract §30 L9)', () => {
  let kernel: KernelInstance
  let tmp: string
  let client: (key: string) => SupabaseClient
  const seats = new Map<string, string>()

  beforeAll(async () => {
    const adapter = openNodeSqlite({ path: ':memory:' })
    await adapter.execute(
      sql(
        'CREATE TABLE notes (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), owner_id TEXT NOT NULL, title TEXT NOT NULL)',
      ),
    )
    tmp = await mkdtemp(join(tmpdir(), 'sk-gw-'))
    kernel = await KernelInstance.create({
      projectRef: 'local',
      serverSecret: 'gw-secret',
      runtime: 'node',
      adapter,
      blob: openFsBlob({ root: tmp }),
      schema: { ...SCHEMA, policies: POLICIES },
      policies: POLICIES,
      ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
      management: { token: 'sk_mgmt_gw', queryEnabled: false },
    })
    const app = createGateway({ kernel, corsOrigins: ['https://app.example.com'] })
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return app.fetch(new Request(url, init))
    }
    client = (key) =>
      createClient('http://gw.local', key, {
        auth: { persistSession: false },
        global: { fetch: fetchImpl as typeof fetch },
      })
    void seats
  })
  afterAll(async () => {
    await kernel.dispose()
    await rm(tmp, { recursive: true, force: true })
  })

  it('auth signup + data insert/select + storage upload/download, all via the gateway', async () => {
    const pub = kernel.authService.apiKeys.publishable
    const anonClient = client(pub)
    const { data: signUp, error } = await anonClient.auth.signUp({
      email: 'g@example.com',
      password: 'password123',
    })
    expect(error).toBeNull()

    const authed = createClient('http://gw.local', pub, {
      auth: { persistSession: false },
      global: {
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          headers.set('authorization', `Bearer ${signUp.session?.access_token}`)
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          return createGateway({ kernel }).fetch(new Request(url, { ...init, headers }))
        }) as typeof fetch,
      },
    })

    const ins = await authed
      .from('notes')
      .insert({ owner_id: signUp.user?.id, title: 'hello' })
      .select('title')
      .single()
    expect(ins.error).toBeNull()
    expect(ins.data?.title).toBe('hello')

    const sel = await authed.from('notes').select('title')
    expect(sel.data).toEqual([{ title: 'hello' }])

    await authed.storage.createBucket('docs')
    const bytes = new Uint8Array(64).fill(9)
    await authed.storage.from('docs').upload('a.bin', bytes)
    const dl = await authed.storage.from('docs').download('a.bin')
    expect(new Uint8Array(await dl.data!.arrayBuffer())).toEqual(bytes)
  })

  it('CORS: an allowed origin is echoed; an unknown origin gets no ACAO header', async () => {
    const app = createGateway({ kernel, corsOrigins: ['https://app.example.com'] })
    const ok = await app.fetch(
      new Request('http://gw/_system/health', { headers: { origin: 'https://app.example.com' } }),
    )
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    const bad = await app.fetch(
      new Request('http://gw/_system/health', { headers: { origin: 'https://evil.example.com' } }),
    )
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('body limit: an oversized Content-Length is rejected 413 before reaching a service', async () => {
    const app = createGateway({ kernel, maxBodyBytes: 100 })
    const res = await app.fetch(
      new Request('http://gw/rest/v1/notes', {
        method: 'POST',
        headers: { 'content-length': '9999', apikey: 'x' },
        body: 'x'.repeat(200),
      }),
    )
    expect(res.status).toBe(413)
  })

  it('the gateway carries no domain SQL / authz — management token still required for /v1', async () => {
    const app = createGateway({ kernel })
    const res = await app.fetch(new Request('http://gw/v1/projects'))
    expect(res.status).toBe(401)
  })

  it('realtime upgrade is delegated to the runtime, not served by the gateway', async () => {
    const app = createGateway({ kernel })
    const res = await app.fetch(new Request('http://gw/realtime/v1/websocket'))
    expect(res.status).toBe(426)
  })
})
