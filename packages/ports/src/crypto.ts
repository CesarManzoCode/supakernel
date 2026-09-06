/**
 * Crypto port (contract §8, §12.2, §25). Wraps WebCrypto + JOSE primitives; the kernel owns
 * claims, key policy and session semantics, not this interface.
 */
export interface CryptoPort {
  /** PBKDF2-HMAC-SHA256, 600k iterations, versioned envelope `sk-pbkdf2-sha256$v=1$i=…`. */
  hashPassword(password: string): Promise<string>
  /** Constant-time verification against a stored envelope. */
  verifyPassword(password: string, envelope: string): Promise<boolean>

  /** HMAC-SHA256 hex, used for secret-key storage and rate-limit bucket keys. */
  hmacSha256(key: string, message: string): Promise<string>
  sha256(bytes: Uint8Array): Promise<string>

  /** Constant-time equality for two hex/base64 digests of equal length. */
  timingSafeEqual(a: string, b: string): boolean

  signJwt(claims: Readonly<Record<string, unknown>>, keyId: string): Promise<string>
  verifyJwt(token: string, options: JwtVerifyOptions): Promise<JwtVerifyResult>
}

export interface JwtVerifyOptions {
  readonly issuer: string
  readonly audience: string
  /** Allowed algorithms; the token's own `alg` never selects the key freely (contract §12.2). */
  readonly algorithms: readonly string[]
}

export type JwtVerifyResult =
  | {
      readonly ok: true
      readonly claims: Readonly<Record<string, unknown>>
      readonly keyId: string
    }
  | {
      readonly ok: false
      readonly reason: 'signature' | 'expired' | 'issuer' | 'audience' | 'alg' | 'malformed'
    }
