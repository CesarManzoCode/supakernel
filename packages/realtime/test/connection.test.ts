import type { Principal, SchemaIR } from '@supakernel/contracts'
import { describe, expect, it } from 'vitest'
import { type OutboxEvent, RealtimeConnection } from '../src/index.js'

const schema: SchemaIR = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'int32', nullable: false, default: null, generated: false },
        { name: 'owner_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'title', type: 'text', nullable: false, default: null, generated: false },
        { name: 'secret', type: 'text', nullable: true, default: null, generated: false },
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

const anon: Principal = {
  kind: 'anonymous',
  subjectId: null,
  tenantId: 'demo',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none',
}
const userA: Principal = {
  kind: 'user',
  subjectId: 'user-a',
  tenantId: 'demo',
  role: 'authenticated',
  sessionId: 's',
  claims: { sub: 'user-a', exp: Math.floor(Date.now() / 1000) + 100 },
  credentialSource: 'jwt',
}

function conn(
  now: () => number,
  verifyToken: (t: string) => Promise<Principal | null> = async () => null,
): RealtimeConnection {
  return new RealtimeConnection(
    {
      schema,
      policies: [],
      issuer: 'i',
      audience: 'a',
      now: () => new Date(now()).toISOString(),
      epochMillis: now,
      anonPrincipal: anon,
      verifyToken,
    },
    userA,
  )
}

const ev = (op: OutboxEvent['op'], row: Record<string, unknown>): OutboxEvent => ({
  seq: 1,
  schema: 'public',
  table: 'notes',
  op,
  pk: { id: row.id },
  old: op === 'INSERT' ? null : (row as Record<string, never>),
  new: op === 'DELETE' ? null : (row as Record<string, never>),
  commitTs: new Date().toISOString(),
})

describe('RealtimeConnection state machine (contract §15)', () => {
  it('heartbeat → phx_reply ok', async () => {
    const out = await conn(() => Date.now()).handleFrame({
      joinRef: null,
      ref: '1',
      topic: 'phoenix',
      event: 'heartbeat',
      payload: {},
    })
    expect(out.frames[0]).toMatchObject({ event: 'phx_reply', payload: { status: 'ok' } })
  })

  it('phx_join with empty postgres_changes (broadcast/presence only) → unsupported_feature', async () => {
    const out = await conn(() => Date.now()).handleFrame({
      joinRef: '1',
      ref: '1',
      topic: 't',
      event: 'phx_join',
      payload: { config: { broadcast: {}, presence: {} } },
    })
    expect(out.frames[0]).toMatchObject({
      event: 'phx_reply',
      payload: { status: 'error', response: { reason: 'unsupported_feature' } },
    })
  })

  it('a schema other than public is rejected', async () => {
    const out = await conn(() => Date.now()).handleFrame({
      joinRef: '1',
      ref: '1',
      topic: 't',
      event: 'phx_join',
      payload: { config: { postgres_changes: [{ event: '*', schema: 'private', table: 'x' }] } },
    })
    expect(out.frames[0]).toMatchObject({ payload: { status: 'error' } })
  })

  it('delivers only rows the channel principal may see; masks unreadable fields', async () => {
    const policies = [
      {
        id: 'own',
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
        fields: { read: ['id', 'owner_id', 'title'] as string[], write: [], immutable: [] },
      },
    ]
    const c = new RealtimeConnection(
      {
        schema: { ...schema, policies },
        policies,
        issuer: 'i',
        audience: 'a',
        now: () => new Date().toISOString(),
        epochMillis: () => Date.now(),
        anonPrincipal: anon,
        verifyToken: async () => null,
      },
      userA,
    )
    await c.handleFrame({
      joinRef: '1',
      ref: '1',
      topic: 't',
      event: 'phx_join',
      payload: { config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] } },
    })
    expect(
      c.deliver(ev('INSERT', { id: 1, owner_id: 'user-b', title: 'hidden', secret: 'S' })).frames,
    ).toHaveLength(0)
    const mine = c.deliver(ev('INSERT', { id: 2, owner_id: 'user-a', title: 'mine', secret: 'S' }))
    expect(mine.frames).toHaveLength(1)
    const data = (mine.frames[0]!.payload as { data: { record: Record<string, unknown> } }).data
    expect(data.record.title).toBe('mine')
    expect(data.record.secret).toBeUndefined()
  })

  it('token expiry with no refresh closes the channel (system + phx_close), and a refresh keeps it open', async () => {
    let t = Date.now()
    const c = conn(
      () => t,
      async (tok) =>
        tok === 'good'
          ? { ...userA, claims: { sub: 'user-a', exp: Math.floor((t + 50_000) / 1000) } }
          : null,
    )
    await c.handleFrame({
      joinRef: '1',
      ref: '1',
      topic: 't',
      event: 'phx_join',
      payload: {
        config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] },
        access_token: 'good',
      },
    })
    expect(c.channelCount).toBe(1)
    t += 10_000
    expect(c.tick().frames).toHaveLength(0)
    // refresh before expiry
    await c.handleFrame({
      joinRef: '1',
      ref: '2',
      topic: 't',
      event: 'access_token',
      payload: { access_token: 'good' },
    })
    t += 60_000
    const closing = c.tick()
    expect(closing.frames.some((f) => f.event === 'phx_close')).toBe(true)
    expect(c.channelCount).toBe(0)
  })
})
