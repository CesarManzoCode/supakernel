import {
  decodeFrame,
  encodeFrame,
  matchesFilter,
  PHX,
  parseFilter,
  RealtimeConnection,
} from '../../dist/index.js'

const anon = {
  kind: 'anonymous',
  subjectId: null,
  tenantId: 'd',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none',
}

Deno.test('phoenix codec round-trips on Deno', () => {
  const f = decodeFrame(JSON.stringify(['1', '2', 't', PHX.join, { config: {} }]))
  if (f.event !== 'phx_join') throw new Error('bad decode')
  if (encodeFrame(f) !== JSON.stringify(['1', '2', 't', 'phx_join', { config: {} }]))
    throw new Error('bad encode')
})

Deno.test('filter parse + match on Deno', () => {
  const flt = parseFilter('n=gte.5')
  if (!matchesFilter(flt, { n: 6 }) || matchesFilter(flt, { n: 4 })) throw new Error('bad filter')
})

Deno.test('connection state machine on Deno', async () => {
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
  const bc = await c.handleFrame({
    joinRef: '1',
    ref: '1',
    topic: 't',
    event: 'phx_join',
    payload: { config: { broadcast: {} } },
  })
  if (bc.frames[0].payload.response.reason !== 'unsupported_feature')
    throw new Error('broadcast not rejected')
  const j = await c.handleFrame({
    joinRef: '1',
    ref: '2',
    topic: 't',
    event: 'phx_join',
    payload: { config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] } },
  })
  if (j.frames[0].payload.status !== 'ok') throw new Error('join failed')
})
