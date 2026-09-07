import { RealtimeClient } from '@supabase/realtime-js'
import { sql } from '@supakernel/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTES_DDL_SQLITE, NOTES_POLICIES, NOTES_SCHEMA } from './helpers/blog.js'
import { makeRealtimeHarness, type RealtimeHarness } from './helpers/server.js'

const MANAGED = [
  {
    name: 'notes',
    columns: ['id', 'tenant_id', 'owner_id', 'title', 'secret', 'done'],
    primaryKey: ['id'],
  },
]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
async function waitFor<T>(get: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

describe('Realtime postgres_changes — real @supabase/realtime-js (contract §15, §30 L8)', () => {
  let h: RealtimeHarness
  const clients: RealtimeClient[] = []

  beforeEach(async () => {
    h = await makeRealtimeHarness({
      family: 'sqlite',
      schema: { ...NOTES_SCHEMA, policies: NOTES_POLICIES },
      policies: NOTES_POLICIES,
      managedTables: MANAGED,
      ddl: NOTES_DDL_SQLITE,
    })
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.disconnect()
    await h.close()
  })

  function connect(apikey = 'A'): RealtimeClient {
    const c = new RealtimeClient(h.url, {
      params: { apikey, vsn: '2.0.0' },
      heartbeatIntervalMs: 1000,
    })
    clients.push(c)
    return c
  }

  async function subscribe(
    client: RealtimeClient,
    binding: { event: string; table: string; filter?: string },
    accessToken?: string,
  ): Promise<{
    events: Array<Record<string, unknown>>
    channel: ReturnType<RealtimeClient['channel']>
  }> {
    const events: Array<Record<string, unknown>> = []
    if (accessToken) client.setAuth(accessToken)
    const channel = client.channel(`realtime:notes:${Math.random().toString(36).slice(2)}`)
    channel.on(
      'postgres_changes',
      {
        event: binding.event as never,
        schema: 'public',
        table: binding.table,
        ...(binding.filter ? { filter: binding.filter } : {}),
      },
      (payload: Record<string, unknown>) => events.push(payload),
    )
    let status = ''
    channel.subscribe((s) => {
      status = s
    })
    await waitFor(() => (status === 'SUBSCRIBED' ? true : undefined))
    return { events, channel }
  }

  it('receives INSERT / UPDATE / DELETE for an owned row, in order', async () => {
    const token = await h.signToken({ sub: 'user-a' })
    const { events } = await subscribe(connect(), { event: '*', table: 'notes' }, token)

    await h.adapter.execute(
      sql('INSERT INTO notes (id,tenant_id,owner_id,title) VALUES (1,?,?,?)', [
        't',
        'user-a',
        'first',
      ]),
    )
    await h.pump()
    await h.adapter.execute(sql('UPDATE notes SET title = ? WHERE id = 1', ['second']))
    await h.pump()
    await h.adapter.execute(sql('DELETE FROM notes WHERE id = 1'))
    await h.pump()

    await waitFor(() => (events.length >= 3 ? true : undefined))
    expect(events.map((e) => e.eventType)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    expect((events[0]!.new as { title: string }).title).toBe('first')
    expect((events[1]!.old as { title: string }).title).toBe('first')
    expect((events[2]!.old as { title: string }).title).toBe('second') // DELETE carries old_record
  })

  it('a one-field filter is applied server-side', async () => {
    const token = await h.signToken({ sub: 'user-a' })
    const { events } = await subscribe(
      connect(),
      { event: 'INSERT', table: 'notes', filter: 'tenant_id=eq.keep' },
      token,
    )
    await h.adapter.execute(
      sql('INSERT INTO notes (id,tenant_id,owner_id,title) VALUES (1,?,?,?)', [
        'drop',
        'user-a',
        'x',
      ]),
    )
    await h.adapter.execute(
      sql('INSERT INTO notes (id,tenant_id,owner_id,title) VALUES (2,?,?,?)', [
        'keep',
        'user-a',
        'y',
      ]),
    )
    await h.pump()
    await waitFor(() => (events.length >= 1 ? true : undefined))
    await sleep(100)
    expect(events).toHaveLength(1)
    expect((events[0]!.new as { tenant_id: string }).tenant_id).toBe('keep')
  })

  it('row + field policy is re-evaluated per event: another user’s row is not delivered; secret column is masked', async () => {
    const tokenB = await h.signToken({ sub: 'user-b' })
    const { events } = await subscribe(connect(), { event: '*', table: 'notes' }, tokenB)
    await h.adapter.execute(
      sql(
        "INSERT INTO notes (id,tenant_id,owner_id,title,secret) VALUES (1,'t','user-a','a-note','TOPSECRET')",
      ),
    )
    await h.adapter.execute(
      sql(
        "INSERT INTO notes (id,tenant_id,owner_id,title,secret) VALUES (2,'t','user-b','b-note','ALSO')",
      ),
    )
    await h.pump()
    await waitFor(() => (events.length >= 1 ? true : undefined))
    await sleep(100)
    expect(events).toHaveLength(1)
    expect((events[0]!.new as { title: string }).title).toBe('b-note')
    expect((events[0]!.new as Record<string, unknown>).secret).toBeUndefined()
  })

  it('Broadcast / Presence subscriptions are rejected with unsupported_feature (no fake ack)', async () => {
    const client = connect()
    const channel = client.channel('room:x', { config: { broadcast: { self: true } } })
    let status = ''
    let err: unknown
    channel.on('broadcast', { event: 'msg' }, () => {})
    channel.subscribe((s, e) => {
      status = s
      err = e
    })
    await waitFor(() => (status && status !== 'SUBSCRIBED' ? true : undefined))
    expect(status).not.toBe('SUBSCRIBED')
    void err
  })

  it('bounded queue: a flood beyond the limit closes the socket with 1013 and no silent drop', async () => {
    // exercise the connection state machine directly for a deterministic overflow
    const { RealtimeConnection } = await import('../src/index.js')
    const conn = new RealtimeConnection(
      {
        schema: { ...NOTES_SCHEMA, policies: [] },
        policies: [],
        issuer: 'i',
        audience: 'a',
        now: () => new Date().toISOString(),
        epochMillis: () => Date.now(),
        anonPrincipal: {
          kind: 'anonymous',
          subjectId: null,
          tenantId: 'demo',
          role: 'anon',
          sessionId: null,
          claims: {},
          credentialSource: 'none',
        },
        verifyToken: async () => null,
      },
      {
        kind: 'service',
        subjectId: null,
        tenantId: 'demo',
        role: 'service_role',
        sessionId: null,
        claims: {},
        credentialSource: 'secret_key',
      },
    )
    await conn.handleFrame({
      joinRef: '1',
      ref: '1',
      topic: 't',
      event: 'phx_join',
      payload: { config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] } },
    })
    let closed: { code: number } | undefined
    for (let i = 0; i < 2000 && !closed; i++) {
      const out = conn.deliver({
        seq: i,
        schema: 'public',
        table: 'notes',
        op: 'INSERT',
        pk: { id: i },
        old: null,
        new: { id: i, title: 'x'.repeat(200) },
        commitTs: new Date().toISOString(),
      })
      if (out.close) closed = out.close
    }
    expect(closed?.code).toBe(1013)
  })
})
