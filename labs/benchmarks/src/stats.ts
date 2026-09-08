// Statistics (contract §23). Bootstrap 95% CI on the median per trial; a winner is claimed
// only when the intervals do not overlap AND the absolute effect is >= 5%. Outliers are
// never removed. Raw HDR-style samples + the command are always retained.

export interface Summary {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

export function summarize(samples: readonly number[]): Summary {
  const s = [...samples].sort((a, b) => a - b)
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  return {
    n: s.length,
    min: s[0] ?? 0,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s[s.length - 1] ?? 0,
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  }
}

/** Deterministic PRNG so a report is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CI {
  readonly median: number
  readonly lo: number
  readonly hi: number
}

export function bootstrapMedianCI(
  samples: readonly number[],
  iterations = 5000,
  seed = 0x5eed,
): CI {
  if (samples.length === 0) return { median: 0, lo: 0, hi: 0 }
  const rnd = mulberry32(seed)
  const medians: number[] = []
  for (let i = 0; i < iterations; i++) {
    const resample: number[] = []
    for (let j = 0; j < samples.length; j++) {
      resample.push(samples[Math.floor(rnd() * samples.length)] ?? 0)
    }
    resample.sort((a, b) => a - b)
    medians.push(resample[Math.floor(resample.length / 2)] ?? 0)
  }
  medians.sort((a, b) => a - b)
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    lo: medians[Math.floor(iterations * 0.025)] ?? 0,
    hi: medians[Math.floor(iterations * 0.975)] ?? 0,
  }
}

export type Verdict = 'inconclusive' | 'a-faster' | 'b-faster'

export function compareVerdict(a: CI, b: CI): { verdict: Verdict; reason: string } {
  const overlap = a.lo <= b.hi && b.lo <= a.hi
  if (overlap) return { verdict: 'inconclusive', reason: 'the 95% bootstrap CIs overlap' }
  const faster = a.median < b.median ? 'a' : 'b'
  const slow = Math.max(a.median, b.median)
  const fast = Math.min(a.median, b.median)
  const effect = slow === 0 ? 0 : (slow - fast) / slow
  if (effect < 0.05)
    return { verdict: 'inconclusive', reason: `absolute effect ${(effect * 100).toFixed(1)}% < 5%` }
  return {
    verdict: faster === 'a' ? 'a-faster' : 'b-faster',
    reason: `non-overlapping CIs, ${(effect * 100).toFixed(1)}% effect`,
  }
}
