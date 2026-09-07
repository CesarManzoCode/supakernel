import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Family, PolicyRule, Principal, SchemaIR } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { createDataHandler } from '../../src/index.js'

export interface Seat {
  readonly key: string
  readonly principal: Principal
}

export function anon(tenantId: string, key = 'anon'): Seat {
  return {
    key,
    principal: {
      kind: 'anonymous',
      subjectId: null,
      tenantId,
      role: 'anon',
      sessionId: null,
      claims: {},
      credentialSource: 'none',
    },
  }
}

export function user(subjectId: string, tenantId: string, key = subjectId): Seat {
  return {
    key,
    principal: {
      kind: 'user',
      subjectId,
      tenantId,
      role: 'authenticated',
      sessionId: `sess-${subjectId}`,
      claims: { sub: subjectId, tenant_id: tenantId, role: 'authenticated' },
      credentialSource: 'jwt',
    },
  }
}

export function service(tenantId: string, key = 'service'): Seat {
  return {
    key,
    principal: {
      kind: 'service',
      subjectId: null,
      tenantId,
      role: 'service_role',
      sessionId: null,
      claims: {},
      credentialSource: 'secret_key',
    },
  }
}

export interface Harness {
  clientFor(seat: Seat): SupabaseClient
  handler: (request: Request) => Promise<Response>
}

export function makeHarness(opts: {
  adapter: DatabaseAdapter
  schema: SchemaIR
  policies: readonly PolicyRule[]
  family: Family
  seats: readonly Seat[]
  now?: () => string
}): Harness {
  const bySeatKey = new Map(opts.seats.map((s) => [s.key, s.principal]))
  const handler = createDataHandler({
    adapter: opts.adapter,
    schema: opts.schema,
    policies: opts.policies,
    family: opts.family,
    now: opts.now ?? (() => new Date('2026-09-06T12:00:00.000Z').toISOString()),
    resolvePrincipal: (headers) => {
      const key =
        headers.get('apikey') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      const principal = bySeatKey.get(key)
      if (!principal) throw new Error(`SK_AUTHN: unknown apikey`)
      return principal
    },
  })

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const req = new Request(url, init)
    return handler(req)
  }

  return {
    handler,
    clientFor: (seat) =>
      createClient('http://sk.test', seat.key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: fetchImpl as typeof fetch },
      }),
  }
}
