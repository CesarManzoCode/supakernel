import type { CryptoPort, RandomPort } from '@supakernel/ports'

/** A 256-bit random token, base64url — only its hash is ever stored (contract §12.2). */
export function randomToken(random: RandomPort): string {
  return Buffer.from(random.bytes(32)).toString('base64url')
}

export function hashToken(crypto: CryptoPort, token: string): Promise<string> {
  return crypto.sha256(new TextEncoder().encode(token))
}
