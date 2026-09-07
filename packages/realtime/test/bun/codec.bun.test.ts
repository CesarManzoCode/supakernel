import { expect, test } from 'bun:test'
import {
  decodeFrame,
  encodeFrame,
  matchesFilter,
  PHX,
  parseFilter,
  RealtimeConnection,
} from '../../src/index.ts'

test('phoenix codec round-trips on Bun', () => {
  const raw = JSON.stringify(['1', '2', 't', PHX.join, { config: {} }])
  const f = decodeFrame(raw)
  expect(f.event).toBe('phx_join')
  expect(JSON.parse(encodeFrame(f))).toEqual(['1', '2', 't', 'phx_join', { config: {} }])
})

test('filter parse + match on Bun', () => {
  const flt = parseFilter('n=gte.5')
  expect(matchesFilter(flt, { n: 6 })).toBe(true)
  expect(matchesFilter(flt, { n: 4 })).toBe(false)
})

test('connection state machine (heartbeat, join, broadcast rejection) on Bun', async () => {
  const anon = {
    kind: 'anonymous' as const,
    subjectId: null,
    tenantId: 'd',
    role: 'anon',
    sessionId: null,
    claims: {},
    credentialSource: 'none' as const,
  }
  const c = new RealtimeConnection(
    {
      schema: {
        version: 1,
        tables: [
          {
            name: 'notes',
            columns: [
              { name: 'id', type: 'int32', nullable: false, default: null, generated: false },
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
      },
      policies: [],
      issuer: 'i',
      audience: 'a',
      now: () => new Date().toISOString(),
      epochMillis: () => Date.now(),
      anonPrincipal: anon,
      verifyToken: async () => null,
    },
    anon,
  )
  const hb = await c.handleFrame({
    joinRef: null,
    ref: '1',
    topic: 'phoenix',
    event: 'heartbeat',
    payload: {},
  })
  expect((hb.frames[0] as { payload: { status: string } }).payload.status).toBe('ok')
  const bc = await c.handleFrame({
    joinRef: '1',
    ref: '1',
    topic: 't',
    event: 'phx_join',
    payload: { config: { broadcast: {} } },
  })
  expect(
    (bc.frames[0] as { payload: { response: { reason: string } } }).payload.response.reason,
  ).toBe('unsupported_feature')
  const join = await c.handleFrame({
    joinRef: '1',
    ref: '2',
    topic: 't',
    event: 'phx_join',
    payload: { config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] } },
  })
  expect((join.frames[0] as { payload: { status: string } }).payload.status).toBe('ok')
  expect(c.channelCount).toBe(1)
})
