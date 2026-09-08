// Comparator modes (contract §19.2).
//
// exact | ordered-sequence | unordered-multiset | subset (declared vendor-extra fields only)
// | predicate (e.g. timestamp window) | state-invariant.

import type { ComparatorMode, Json, JsonArray, JsonObject } from '@supakernel/contracts'
import { canonicalJson, isJsonArray, isJsonObject, jsonEquals } from '@supakernel/contracts'

export interface DiffEntry {
  /** JSON pointer-ish path into the normalized observation. */
  readonly path: string
  readonly expected: Json
  readonly actual: Json
  readonly note: string
}

export interface CompareInput {
  readonly mode: ComparatorMode
  /** Fields present only on the vendor side that `subset` mode may ignore. */
  readonly extraVendorFields: readonly string[]
  /** Baseline (oracle) normalized value. */
  readonly baseline: Json
  /** Candidate target normalized value. */
  readonly candidate: Json
}

function multisetKey(v: Json): string {
  return canonicalJson(v)
}

function stripExtra(value: Json, extra: ReadonlySet<string>): Json {
  if (isJsonArray(value)) return value.map((v) => stripExtra(v, extra))
  if (isJsonObject(value)) {
    const out: JsonObject = {}
    for (const [k, val] of Object.entries(value)) {
      if (!extra.has(k)) out[k] = stripExtra(val as Json, extra)
    }
    return out
  }
  return value
}

function diffExact(baseline: Json, candidate: Json, path: string, out: DiffEntry[]): void {
  if (jsonEquals(baseline, candidate)) return
  if (isJsonObject(baseline) && isJsonObject(candidate)) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)])
    for (const k of [...keys].sort()) {
      diffExact((baseline[k] ?? null) as Json, (candidate[k] ?? null) as Json, `${path}/${k}`, out)
    }
    return
  }
  if (isJsonArray(baseline) && isJsonArray(candidate)) {
    const len = Math.max(baseline.length, candidate.length)
    for (let i = 0; i < len; i++) {
      diffExact((baseline[i] ?? null) as Json, (candidate[i] ?? null) as Json, `${path}/${i}`, out)
    }
    return
  }
  out.push({ path: path || '/', expected: baseline, actual: candidate, note: 'value mismatch' })
}

function diffMultiset(baseline: JsonArray, candidate: JsonArray, out: DiffEntry[]): void {
  const counts = new Map<string, number>()
  for (const v of baseline) counts.set(multisetKey(v), (counts.get(multisetKey(v)) ?? 0) + 1)
  for (const v of candidate) {
    const key = multisetKey(v)
    const c = counts.get(key) ?? 0
    counts.set(key, c - 1)
  }
  for (const [key, delta] of counts) {
    if (delta > 0) {
      out.push({
        path: '/',
        expected: JSON.parse(key) as Json,
        actual: null,
        note: `missing ×${delta} from candidate`,
      })
    } else if (delta < 0) {
      out.push({
        path: '/',
        expected: null,
        actual: JSON.parse(key) as Json,
        note: `extra ×${-delta} in candidate`,
      })
    }
  }
}

/**
 * A predicate observation is compared by shape: the baseline holds
 * `{ predicate: '<name>', value: <normalized> }` and both sides must satisfy the same
 * relation. Here we assert equality of the normalized ordinal (windows collapse to ordinals
 * in normalize.ts), which is strictly weaker than exact wall-clock comparison but never
 * hides a reordering.
 */
function diffPredicate(baseline: Json, candidate: Json, out: DiffEntry[]): void {
  if (!jsonEquals(baseline, candidate)) {
    out.push({ path: '/', expected: baseline, actual: candidate, note: 'predicate not satisfied' })
  }
}

export function compare(input: CompareInput): DiffEntry[] {
  const out: DiffEntry[] = []
  const { mode, baseline, candidate } = input
  switch (mode) {
    case 'exact': {
      diffExact(baseline, candidate, '', out)
      break
    }
    case 'ordered-sequence': {
      diffExact(baseline, candidate, '', out)
      break
    }
    case 'unordered-multiset': {
      if (isJsonArray(baseline) && isJsonArray(candidate)) {
        diffMultiset(baseline, candidate, out)
      } else {
        out.push({
          path: '/',
          expected: baseline,
          actual: candidate,
          note: 'multiset compare needs arrays',
        })
      }
      break
    }
    case 'subset': {
      const extra = new Set(input.extraVendorFields)
      diffExact(stripExtra(baseline, extra), stripExtra(candidate, extra), '', out)
      break
    }
    case 'predicate': {
      diffPredicate(baseline, candidate, out)
      break
    }
    case 'state-invariant': {
      diffExact(baseline, candidate, '', out)
      break
    }
    default: {
      const never: never = mode
      throw new Error(`unhandled comparator ${String(never)}`)
    }
  }
  return out
}
