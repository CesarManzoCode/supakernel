import { base64ToUtf8 } from '@supakernel/contracts'
import type { JwtVerifyOptions, JwtVerifyResult } from '@supakernel/ports'
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
} from 'jose'

/** ES256 is the only algorithm SupaKernel signs with (contract §12.2). */
export const SIGNING_ALG = 'ES256' as const

export interface SigningKeyPair {
  readonly kid: string
  readonly alg: 'ES256'
  readonly status: 'active' | 'retired'
  readonly privateJwk: JWK
  readonly publicJwk: JWK
}

/** Generate a fresh ES256 signing key with a random `kid`. */
export async function generateSigningKey(kid?: string): Promise<SigningKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, { extractable: true })
  const [privateJwk, publicJwk] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)])
  const id = kid ?? `sk_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  return { kid: id, alg: SIGNING_ALG, status: 'active', privateJwk, publicJwk }
}

interface LoadedKey {
  readonly kid: string
  readonly alg: string
  readonly status: 'active' | 'retired'
  readonly privateKey: CryptoKey
  readonly publicKey: CryptoKey
}

/**
 * A keyring: exactly one active key signs; retired keys still verify until removed by rotation.
 * The token's own `alg` never selects the key — the key is chosen by `kid` and the algorithm
 * allowlist is enforced independently (contract §12.2: no alg confusion).
 */
export class JwtKeyring {
  private readonly byKid = new Map<string, LoadedKey>()
  private activeKid: string | null = null

  static async fromKeys(keys: readonly SigningKeyPair[]): Promise<JwtKeyring> {
    const ring = new JwtKeyring()
    for (const k of keys) await ring.add(k)
    return ring
  }

  async add(key: SigningKeyPair): Promise<void> {
    const [privateKey, publicKey] = await Promise.all([
      importJWK(key.privateJwk, key.alg) as Promise<CryptoKey>,
      importJWK(key.publicJwk, key.alg) as Promise<CryptoKey>,
    ])
    this.byKid.set(key.kid, {
      kid: key.kid,
      alg: key.alg,
      status: key.status,
      privateKey,
      publicKey,
    })
    if (key.status === 'active') this.activeKid = key.kid
  }

  get activeKeyId(): string {
    if (!this.activeKid) throw new Error('SK_CRYPTO_NO_ACTIVE_KEY')
    return this.activeKid
  }

  async sign(claims: Readonly<Record<string, unknown>>, keyId?: string): Promise<string> {
    const kid = keyId ?? this.activeKeyId
    const key = this.byKid.get(kid)
    if (!key) throw new Error(`SK_CRYPTO_UNKNOWN_KID: ${kid}`)
    const payload = { ...claims } as JWTPayload
    const jwt = new SignJWT(payload).setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    if (payload.iat === undefined) jwt.setIssuedAt()
    return jwt.sign(key.privateKey)
  }

  async verify(
    token: string,
    options: JwtVerifyOptions,
    currentDate?: Date,
  ): Promise<JwtVerifyResult> {
    let header: { alg?: unknown; kid?: unknown }
    try {
      header = JSON.parse(base64ToUtf8(token.split('.')[0] ?? ''))
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (typeof header.alg !== 'string' || !options.algorithms.includes(header.alg)) {
      return { ok: false, reason: 'alg' }
    }
    if (typeof header.kid !== 'string') return { ok: false, reason: 'malformed' }
    const key = this.byKid.get(header.kid)
    if (!key) return { ok: false, reason: 'signature' }

    try {
      const { payload } = await jwtVerify(token, key.publicKey, {
        algorithms: [...options.algorithms],
        issuer: options.issuer,
        audience: options.audience,
        ...(currentDate ? { currentDate } : {}),
      })
      return { ok: true, claims: payload as Record<string, unknown>, keyId: key.kid }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        return { ok: false, reason: err.claim === 'iss' ? 'issuer' : 'audience' }
      }
      if (err instanceof joseErrors.JWSSignatureVerificationFailed)
        return { ok: false, reason: 'signature' }
      if (err instanceof joseErrors.JOSEAlgNotAllowed) return { ok: false, reason: 'alg' }
      return { ok: false, reason: 'malformed' }
    }
  }
}
