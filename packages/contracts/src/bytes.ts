/**
 * Portable base64 / base64url (contract §7 — the core runs on Node, Bun, Deno, workerd and the
 * browser with no Node built-ins and no polyfill; `Buffer` is Node-only). `atob` / `btoa` are
 * global on every target runtime.
 */

function toBinary(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return s
}

/** Standard base64 of raw bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(toBinary(bytes))
}

/** URL-safe base64 with no padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode standard or URL-safe base64 (padding optional) to raw bytes. */
export function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Decode base64 (standard or URL-safe) to a UTF-8 string. */
export function base64ToUtf8(input: string): string {
  return new TextDecoder().decode(base64ToBytes(input))
}
