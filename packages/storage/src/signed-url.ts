import type { CryptoPort } from '@supakernel/ports'
import { STORAGE_ERRORS } from './errors.js'

/**
 * A Storage signed token (contract §14.2): ES256, `aud=storage`, exact project / bucket /
 * canonical path / operation, expiry 60s–7d. It can only authorize `GET` / `HEAD` of the exact
 * object — it never broadens the method, range or path and never inherits `service_role`.
 */
export interface SignedTokenClaims {
  readonly project: string
  readonly bucket: string
  readonly path: string
  readonly operation: 'read'
  readonly exp: number
  readonly iat: number
  readonly aud: 'storage'
  readonly nonce?: string
}

const MIN_TTL = 60
const MAX_TTL = 7 * 24 * 3600

export async function mintSignedToken(
  crypto: CryptoPort,
  keyId: string,
  input: { project: string; bucket: string; path: string; ttlSeconds: number; nowMs: number; nonce?: string },
): Promise<string> {
  const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, Math.floor(input.ttlSeconds)))
  const iat = Math.floor(input.nowMs / 1000)
  const claims = {
    project: input.project,
    bucket: input.bucket,
    path: input.path,
    operation: 'read' as const,
    aud: 'storage' as const,
    iss: 'storage',
    iat,
    exp: iat + ttl,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  }
  return crypto.signJwt(claims, keyId)
}

export async function verifySignedToken(
  crypto: CryptoPort,
  token: string,
  expect: { project: string; bucket: string; path: string; nowMs: number },
): Promise<SignedTokenClaims> {
  const result = await crypto.verifyJwt(token, { issuer: 'storage', audience: 'storage', algorithms: ['ES256'] })
  if (!result.ok) throw STORAGE_ERRORS.invalidSignedToken()
  return assertClaims(result.claims as Record<string, unknown>, expect)
}

function assertClaims(
  claims: Record<string, unknown>,
  expect: { project: string; bucket: string; path: string; nowMs: number },
): SignedTokenClaims {
  if (
    claims.aud !== 'storage' ||
    claims.operation !== 'read' ||
    claims.project !== expect.project ||
    claims.bucket !== expect.bucket ||
    claims.path !== expect.path
  ) {
    throw STORAGE_ERRORS.invalidSignedToken()
  }
  const exp = Number(claims.exp ?? 0)
  if (!Number.isFinite(exp) || exp * 1000 < expect.nowMs) throw STORAGE_ERRORS.invalidSignedToken()
  return claims as unknown as SignedTokenClaims
}
