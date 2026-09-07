// WebCrypto + jose implementation of `@supakernel/ports` CryptoPort (contract §12.2, §25, §33.1).

import type { CryptoPort, JwtVerifyOptions, JwtVerifyResult } from '@supakernel/ports'
import { hmacSha256, sha256 } from './hmac.js'
import { JwtKeyring, type SigningKeyPair } from './jwt.js'
import { hashPassword, timingSafeEqual, verifyPassword } from './password.js'

export { hmacSha256, sha256 } from './hmac.js'
export { generateSigningKey, JwtKeyring, SIGNING_ALG, type SigningKeyPair } from './jwt.js'
export { hashPassword, needsRehash, timingSafeEqual, verifyPassword } from './password.js'

class WebCryptoPort implements CryptoPort {
  private readonly keyring: JwtKeyring
  constructor(keyring: JwtKeyring) {
    this.keyring = keyring
  }
  hashPassword(password: string): Promise<string> {
    return hashPassword(password)
  }
  verifyPassword(password: string, envelope: string): Promise<boolean> {
    return verifyPassword(password, envelope)
  }
  hmacSha256(key: string, message: string): Promise<string> {
    return hmacSha256(key, message)
  }
  sha256(bytes: Uint8Array): Promise<string> {
    return sha256(bytes)
  }
  timingSafeEqual(a: string, b: string): boolean {
    return timingSafeEqual(a, b)
  }
  signJwt(claims: Readonly<Record<string, unknown>>, keyId: string): Promise<string> {
    return this.keyring.sign(claims, keyId)
  }
  verifyJwt(token: string, options: JwtVerifyOptions): Promise<JwtVerifyResult> {
    return this.keyring.verify(token, options)
  }
}

export async function createWebCryptoPort(
  keys: readonly SigningKeyPair[],
): Promise<CryptoPort & { keyring: JwtKeyring }> {
  const keyring = await JwtKeyring.fromKeys(keys)
  const port = new WebCryptoPort(keyring)
  return Object.assign(port, { keyring })
}
