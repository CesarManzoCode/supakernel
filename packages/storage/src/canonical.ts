import { kernelError } from '@supakernel/contracts'

/**
 * Canonicalize an object path (contract §14.1): UTF-8 NFC normalized, `/` is the only logical
 * separator, no `..`, no NUL, no backslash, no double percent-decoding. The adapter only ever
 * receives the canonical key — never the raw user path.
 */
export function canonicalPath(raw: string): string {
  if (raw.includes('\u0000') || /%00/i.test(raw)) throw invalid('path contains a NUL byte')
  if (raw.includes('\\')) throw invalid('path contains a backslash')

  // reject a path that only becomes traversal after a second percent-decode
  const once = safeDecode(raw)
  const twice = safeDecode(once)
  if (twice !== once) throw invalid('path uses double percent-encoding')

  const normalized = once.normalize('NFC')
  const segments = normalized.split('/').filter((s) => s.length > 0)
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw invalid('path contains a relative segment')
  }
  const joined = segments.join('/')
  if (joined.length === 0) throw invalid('path is empty')
  return joined
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function invalid(detail: string): Error {
  const e = new Error(`SK_STORAGE_INVALID_PATH: ${detail}`)
  ;(e as Error & { kernelError: unknown }).kernelError = kernelError({
    category: 'input',
    code: 'SK_STORAGE_INVALID_PATH',
    message: `invalid object path: ${detail}`,
    httpStatus: 400,
  })
  return e
}

export function isValidBucketName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)
}
