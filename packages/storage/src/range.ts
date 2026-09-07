import type { ByteRange } from '@supakernel/ports'

/** Parse a single-range `Range: bytes=…` header (contract §14.2). Returns `null` when absent. */
export function parseRangeHeader(header: string | null): ByteRange | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const startRaw = m[1] ?? ''
  const endRaw = m[2] ?? ''
  if (startRaw === '' && endRaw === '') return null
  if (startRaw === '') {
    // suffix range: last N bytes — resolved against total size by the caller
    return { start: -Number(endRaw), end: null }
  }
  return { start: Number(startRaw), end: endRaw === '' ? null : Number(endRaw) }
}

/** Resolve a (possibly suffix) range against a known total size. */
export function resolveRange(range: ByteRange, total: number): { start: number; end: number } {
  if (range.start < 0) {
    const start = Math.max(0, total + range.start)
    return { start, end: total - 1 }
  }
  return { start: range.start, end: range.end === null ? total - 1 : Math.min(range.end, total - 1) }
}
