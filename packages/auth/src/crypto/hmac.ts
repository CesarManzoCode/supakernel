/** HMAC-SHA256 (hex) and SHA-256 (hex) via WebCrypto (contract §12.2, §25). */

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return toHex(sig)
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}
