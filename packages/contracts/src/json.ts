/**
 * Canonical JSON value. The single serialization currency of the kernel (contract §8).
 * `number` here is an IEEE-754 double; logical `int64` / `decimal` that exceed the safe range
 * travel as strings and are marshalled by the schema layer, never widened to `number`.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type JsonObject = { [key: string]: Json }
export type JsonArray = Json[]

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonArray(value: Json): value is JsonArray {
  return Array.isArray(value)
}

/**
 * Deterministic canonical serialization: object keys sorted lexicographically, no insignificant
 * whitespace. Two structurally equal values always produce byte-identical output. Used for
 * hashing schema IR, policy fingerprints and conformance normalization.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError('canonicalJson: non-finite number')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`)
  return `{${body.join(',')}}`
}

/** Structural deep-equality for `Json` values (key order independent). */
export function jsonEquals(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b)
}
