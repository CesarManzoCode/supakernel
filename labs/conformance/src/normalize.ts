// Deterministic normalization (contract §19.2).
//
// Normalizers may only transform fields explicitly declared nondeterministic. They must
// never remove an error, row, field, status or ordering the contract treats as significant.
// Every normalizer here is a total, pure function of (value, context) and is covered by
// mutation tests in test/normalize.test.ts.

import type { Json, JsonArray, JsonObject, NormalizerId } from '@supakernel/contracts'
import { isJsonArray, isJsonObject } from '@supakernel/contracts'

export interface NormalizeContext {
  /** Stable bijection: raw UUID -> canonical placeholder (`<uuid:1>`, `<uuid:2>`, ...). */
  readonly uuids: Map<string, string>
  /** Stable bijection for timestamps -> ordinal, preserving observed order. */
  readonly timestamps: Map<string, number>
  /** Origin -> `<origin>` placeholder. */
  readonly origins: Map<string, string>
}

export function newContext(): NormalizeContext {
  return { uuids: new Map(), timestamps: new Map(), origins: new Map() }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function bijection(map: Map<string, string>, raw: string, prefix: string): string {
  const existing = map.get(raw)
  if (existing !== undefined) return existing
  const placeholder = `<${prefix}:${map.size + 1}>`
  map.set(raw, placeholder)
  return placeholder
}

function normalizeUuid(value: string, ctx: NormalizeContext): string {
  return bijection(ctx.uuids, value.toLowerCase(), 'uuid')
}

function normalizeTimestamp(value: string, ctx: NormalizeContext): string {
  const ms = Date.parse(value)
  const key = Number.isNaN(ms) ? value : String(ms)
  if (!ctx.timestamps.has(key)) {
    // Ordinal assigned by observed order; comparator can still assert relative ordering
    // and windows without depending on wall-clock values.
    ctx.timestamps.set(key, ctx.timestamps.size + 1)
  }
  return `<ts:${ctx.timestamps.get(key)}>`
}

function decodeJwtPart(part: string): Json {
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json) as Json
  } catch {
    return null
  }
}

// Claims whose presence/wording is issuer-specific and carries no cross-oracle signal for the
// §12 endpoint/state observations: compared as `<present>` so the shape still matters.
const VOLATILE_CLAIMS = new Set(['iat', 'exp', 'nbf', 'iss', 'aud', 'jti', 'kid', 'ref'])
const ISSUER_CLAIMS = new Set(['aal', 'amr'])

/**
 * JWT -> { header, claims, validitySeconds }. Claim *values* are run through the shared
 * normalize context so a `sub` UUID lines up with the same user's `id` elsewhere in the
 * observation; issuer-specific timing/identity claims collapse to `<present>`.
 */
function normalizeJwt(value: string, opts: NormalizeOptions): JsonObject {
  const [h, p] = value.split('.')
  const header = decodeJwtPart(h ?? '')
  const payload = decodeJwtPart(p ?? '')
  const claims: JsonObject = {}
  let validitySeconds: Json = null
  if (isJsonObject(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      if (VOLATILE_CLAIMS.has(k)) claims[k] = '<present>'
      else if (ISSUER_CLAIMS.has(k)) claims[k] = '<issuer-specific>'
      else claims[k] = walk(v as Json, opts)
    }
    if (typeof payload.exp === 'number' && typeof payload.iat === 'number') {
      validitySeconds = payload.exp - payload.iat
    }
  }
  const headerOut: JsonObject = {}
  if (isJsonObject(header)) {
    for (const [k, v] of Object.entries(header)) {
      headerOut[k] = k === 'kid' ? '<kid>' : (v as Json)
    }
  }
  return { kind: '<jwt>', header: headerOut, claims, validitySeconds }
}

/**
 * Numeric fields carrying an absolute wall-clock instant (unix seconds). Their value is
 * `now + validity` and varies every run; the relative sibling (`expires_in`) carries the
 * cross-oracle signal and is kept verbatim. Collapsed to `<epoch>` under `timestamp-window`.
 */
const EPOCH_SECONDS_KEYS = new Set(['expires_at'])

/** Opaque secret/token fields that differ by construction between issuers. */
const OPAQUE_TOKEN_KEYS = new Set([
  'refresh_token',
  'provider_token',
  'provider_refresh_token',
  'confirmation_token',
  'recovery_token',
])

function normalizeUrlOrigin(value: string, ctx: NormalizeContext): string {
  try {
    const u = new URL(value)
    bijection(ctx.origins, u.origin, 'origin')
    const search = new URLSearchParams(u.search)
    // token query params are JWTs or opaque; normalize their shape, keep the key present
    for (const key of [...search.keys()]) {
      const raw = search.get(key) ?? ''
      if (JWT_RE.test(raw)) search.set(key, '<jwt>')
      else if (UUID_RE.test(raw)) search.set(key, '<uuid>')
    }
    const qs = search.toString()
    return `<origin>${u.pathname}${qs ? `?${qs}` : ''}`
  } catch {
    return value
  }
}

const CONSTRAINT_NAME_RE = /"([A-Za-z_][A-Za-z0-9_]*)"/g

/** Replace generated constraint identifiers in an error message with a semantic marker. */
function normalizeConstraintNames(message: string): string {
  return message
    .replace(/\b(?:pk|fk|uq|chk|idx)_[a-z0-9_]+/gi, '<constraint>')
    .replace(/\b[a-z0-9_]+_(?:pkey|key|fkey|check|idx)\b/gi, '<constraint>')
    .replace(CONSTRAINT_NAME_RE, (m, id: string) =>
      /_(?:pkey|key|fkey|check|idx)$/i.test(id) ? '"<constraint>"' : m,
    )
}

export interface NormalizeOptions {
  readonly normalizers: readonly NormalizerId[]
  readonly ctx: NormalizeContext
}

function walk(value: Json, opts: NormalizeOptions): Json {
  const active = new Set(opts.normalizers)
  const recurseObject = (obj: JsonObject): JsonObject => {
    const out: JsonObject = {}
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key] as Json
      if (active.has('jwt-claims') && OPAQUE_TOKEN_KEYS.has(key) && typeof v === 'string') {
        out[key] = '<opaque-token>'
      } else if (
        active.has('timestamp-window') &&
        EPOCH_SECONDS_KEYS.has(key) &&
        typeof v === 'number'
      ) {
        out[key] = '<epoch>'
      } else {
        out[key] = walk(v, opts)
      }
    }
    return out
  }
  const recurseArray = (arr: JsonArray): JsonArray => arr.map((v) => walk(v as Json, opts))

  if (isJsonArray(value)) return recurseArray(value)
  if (isJsonObject(value)) return recurseObject(value)
  if (typeof value !== 'string') return value

  let s = value
  if (active.has('jwt-claims') && JWT_RE.test(s)) return normalizeJwt(s, opts)
  if (active.has('uuid-bijection') && UUID_RE.test(s)) return normalizeUuid(s, opts.ctx)
  if (active.has('timestamp-window') && ISO_TS_RE.test(s)) return normalizeTimestamp(s, opts.ctx)
  if (active.has('url-origin') && /^https?:\/\//.test(s)) return normalizeUrlOrigin(s, opts.ctx)
  if (active.has('constraint-name') && /constraint|violat|duplicate key/i.test(s)) {
    s = normalizeConstraintNames(s)
  }
  return s
}

/** Normalize one JSON value with the scenario's declared normalizer set. */
export function normalize(value: Json, opts: NormalizeOptions): Json {
  return walk(value, opts)
}
