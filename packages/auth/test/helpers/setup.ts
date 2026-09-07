import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sql } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import type { ClockPort, DatabaseAdapter } from '@supakernel/ports'
import { createMemoryMailSink, type MemoryMailSink } from '@supakernel/ports'
import { AuthService, authSchemaStatements, createAuthHandler, webRandom } from '../../src/index.js'

export interface FakeClock extends ClockPort {
  advance(ms: number): void
  set(ms: number): void
}

export function fakeClock(startMs = Date.parse('2026-09-06T12:00:00.000Z')): FakeClock {
  let ms = startMs
  return {
    now: () => new Date(ms).toISOString(),
    epochMillis: () => ms,
    monotonicMillis: () => ms,
    advance: (d) => {
      ms += d
    },
    set: (v) => {
      ms = v
    },
  }
}

export interface AuthHarness {
  service: AuthService
  mail: MemoryMailSink
  clock: FakeClock
  adapter: DatabaseAdapter
  handler: (r: Request) => Promise<Response>
  client(): SupabaseClient
  admin(): SupabaseClient
  raw(path: string, init?: RequestInit): Promise<Response>
}

export async function makeAuthHarness(family: 'postgres' | 'sqlite'): Promise<AuthHarness> {
  const adapter: DatabaseAdapter =
    family === 'postgres'
      ? openPostgres({ url: process.env.SUPAKERNEL_TEST_PG_URL as string })
      : openNodeSqlite({ path: ':memory:' })

  for (const stmt of authSchemaStatements(family)) await adapter.execute(sql(stmt))

  const mail = createMemoryMailSink()
  const clock = fakeClock()
  const service = await AuthService.create({
    adapter,
    ports: { clock, random: webRandom(), mail },
    config: { projectRef: 'demo', serverSecret: 'test-server-secret', autoConfirm: true },
  })
  const handler = createAuthHandler(service)

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(new Request(url, init))
  }

  const client = (key: string): SupabaseClient =>
    createClient('http://sk.test', key, {
      auth: { persistSession: false, autoRefreshToken: false, flowType: 'implicit' },
      global: { fetch: fetchImpl as typeof fetch },
    })

  return {
    service,
    mail,
    clock,
    adapter,
    handler,
    client: () => client(service.apiKeys.publishable),
    admin: () => client(service.apiKeys.secret),
    raw: (path, init) => handler(new Request(`http://sk.test${path}`, init)),
  }
}
