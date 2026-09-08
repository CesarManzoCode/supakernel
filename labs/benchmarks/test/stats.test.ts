import { describe, expect, it } from 'vitest'
import {
  bootstrapMedianCI,
  captureEnvironment,
  compareVerdict,
  REQUIRED_DURABILITY,
  summarize,
  validate,
  WORKLOAD_OPS,
} from '../src/index.js'

describe('benchmark stats (contract §23)', () => {
  it('summarize is order-independent and p50 is the median', () => {
    const s = summarize([5, 1, 3, 2, 4])
    expect(s.p50).toBe(3)
    expect(s.min).toBe(1)
    expect(s.max).toBe(5)
  })

  it('bootstrap CI is deterministic for a fixed seed', () => {
    const samples = Array.from({ length: 50 }, (_, i) => 100 + (i % 7))
    expect(bootstrapMedianCI(samples)).toEqual(bootstrapMedianCI(samples))
  })

  it('no winner when the CIs overlap', () => {
    const a = { median: 100, lo: 95, hi: 108 }
    const b = { median: 104, lo: 99, hi: 112 }
    expect(compareVerdict(a, b).verdict).toBe('inconclusive')
  })

  it('no winner when the absolute effect is < 5%', () => {
    const a = { median: 100, lo: 99, hi: 101 }
    const b = { median: 103, lo: 102, hi: 104 }
    expect(compareVerdict(a, b).verdict).toBe('inconclusive')
  })

  it('a winner only with non-overlapping CIs AND >= 5% effect', () => {
    const a = { median: 100, lo: 98, hi: 102 }
    const b = { median: 200, lo: 195, hi: 205 }
    expect(compareVerdict(a, b).verdict).toBe('a-faster')
  })
})

describe('benchmark environment + workload (contract §23.1)', () => {
  it('records whether the runner is dedicated', () => {
    const env = captureEnvironment()
    expect(typeof env.dedicated).toBe('boolean')
    expect(env.note).toMatch(env.dedicated ? /dedicated/ : /SHARED/)
  })
  it('the workload is the strict BKND intersection — no RLS/Auth/Storage', () => {
    expect(
      WORKLOAD_OPS.every((o) =>
        ['list', 'get', 'page', 'insert', 'update', 'delete'].includes(o.kind),
      ),
    ).toBe(true)
    expect(REQUIRED_DURABILITY.journalMode).toBe('WAL')
  })
  it('validate is exported and typed', () => {
    expect(typeof validate).toBe('function')
  })
})
