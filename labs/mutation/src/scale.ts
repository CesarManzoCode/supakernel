// Property campaign scale (contract §20). PR budget: 100 runs/model. Nightly: 10,000 or
// 30 min. Release: 100,000 seeds, sharded. The gate is *zero unclassified counterexample*,
// not the run count.

export const PROPERTY_SCALE: Readonly<Record<string, number>> = {
  pr: 100,
  nightly: 10_000,
  release: 100_000,
}

export function propertyRuns(multiplier = 1): number {
  const scale = process.env.SUPAKERNEL_PROPERTY_SCALE ?? 'pr'
  const base = PROPERTY_SCALE[scale] ?? PROPERTY_SCALE.pr ?? 100
  return Math.max(1, Math.floor(base * multiplier))
}
