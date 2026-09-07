/**
 * PBKDF2-HMAC-SHA256 password hashing (contract §12.2). 600,000 iterations, 128-bit salt,
 * 256-bit output, via WebCrypto. Portable envelope:
 *
 *   sk-pbkdf2-sha256$v=1$i=600000$<salt-b64>$<hash-b64>
 *
 * The work factor changes only through a migration + rehash-on-login.
 */
import { base64ToBytes, bytesToBase64 } from '@supakernel/contracts'

const ITERATIONS = 600_000
const SALT_BYTES = 16
const HASH_BITS = 256
const PREFIX = 'sk-pbkdf2-sha256'

function b64(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
}
/** ArrayBuffer-backed copy — WebCrypto rejects SharedArrayBuffer-typed views. */
function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(base64ToBytes(s))
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES)) as Uint8Array<ArrayBuffer>
  const hash = await derive(password, salt, ITERATIONS)
  return `${PREFIX}$v=1$i=${ITERATIONS}$${b64(salt)}$${b64(hash)}`
}

export async function verifyPassword(password: string, envelope: string): Promise<boolean> {
  const parts = envelope.split('$')
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== 'v=1') return false
  const iterations = Number((parts[2] ?? '').replace(/^i=/, ''))
  if (!Number.isInteger(iterations) || iterations < 1) return false
  const salt = unb64(parts[3] as string)
  const expected = unb64(parts[4] as string)
  const actual = await derive(password, salt, iterations)
  return timingSafeEqualBytes(actual, expected)
}

/** Whether a stored envelope was produced with a weaker work factor and should be rehashed. */
export function needsRehash(envelope: string): boolean {
  const m = /\$i=(\d+)\$/.exec(envelope)
  return !m || Number(m[1]) < ITERATIONS
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
