import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeFrame, matchesFilter, PHX, parseFilter, reply } from '../src/index.js'

describe('Phoenix v2 codec (contract §15)', () => {
  it('round-trips [joinRef, ref, topic, event, payload]', () => {
    const raw = JSON.stringify(['1', '2', 'realtime:room', PHX.join, { config: {} }])
    const f = decodeFrame(raw)
    expect(f).toEqual({
      joinRef: '1',
      ref: '2',
      topic: 'realtime:room',
      event: 'phx_join',
      payload: { config: {} },
    })
    expect(JSON.parse(encodeFrame(f))).toEqual([
      '1',
      '2',
      'realtime:room',
      'phx_join',
      { config: {} },
    ])
  })

  it('server frames carry null joinRef / ref', () => {
    const r = reply({ joinRef: null, ref: '9', topic: 't', event: PHX.join, payload: null }, 'ok', {
      x: 1,
    })
    expect(r).toMatchObject({
      joinRef: null,
      ref: '9',
      event: 'phx_reply',
      payload: { status: 'ok', response: { x: 1 } },
    })
  })

  it('rejects a malformed frame', () => {
    expect(() => decodeFrame('not json')).toThrow('SK_RT_MALFORMED_FRAME')
    expect(() => decodeFrame('[1,2,3]')).toThrow('SK_RT_MALFORMED_FRAME')
  })
})

describe('single-field change filter (contract §15)', () => {
  it('parses column=op.value forms', () => {
    expect(parseFilter('tenant_id=eq.t1')).toEqual({ column: 'tenant_id', op: 'eq', value: 't1' })
    expect(parseFilter('n=gte.5')).toEqual({ column: 'n', op: 'gte', value: 5 })
    expect(parseFilter('s=in.(a,b,c)')).toEqual({ column: 's', op: 'in', value: ['a', 'b', 'c'] })
    expect(parseFilter(null)).toBeNull()
    expect(() => parseFilter('bad')).toThrow()
  })

  it('matches a row against the filter, missing column → no match', () => {
    const f = parseFilter('tenant_id=eq.t1')
    expect(matchesFilter(f, { tenant_id: 't1' })).toBe(true)
    expect(matchesFilter(f, { tenant_id: 't2' })).toBe(false)
    expect(matchesFilter(f, { other: 'x' })).toBe(false)
    expect(matchesFilter(null, { anything: 1 })).toBe(true)
  })
})
