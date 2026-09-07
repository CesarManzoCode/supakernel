import { createHash } from 'node:crypto'
import type {
  BlobAdapter,
  BlobExpectation,
  BlobRead,
  BlobStat,
  ByteRange,
  StagedBlob,
} from '@supakernel/ports'

interface Entry {
  bytes: Uint8Array
  sha256: string
  createdAt: number
  contentType: string | null
}

/** In-memory `BlobAdapter` — TESTS ONLY, does not count toward the adapter matrix (contract §14). */
export class MemoryBlob implements BlobAdapter {
  readonly id = 'memory-blob'
  private staging = new Map<string, Entry>()
  private objects = new Map<string, Entry>()
  /** Fault hook: throw after this many `promote` calls. */
  failPromoteAfter = Number.POSITIVE_INFINITY
  private promoteCount = 0

  async putStaged(
    opId: string,
    body: ReadableStream<Uint8Array>,
    expected: BlobExpectation,
  ): Promise<StagedBlob> {
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > expected.maxBytes) throw err('SK_STORAGE_TOO_LARGE', 413)
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      bytes.set(c, off)
      off += c.byteLength
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (expected.sha256 && expected.sha256 !== sha256) throw err('SK_STORAGE_HASH_MISMATCH', 400)
    this.staging.set(opId, {
      bytes,
      sha256,
      createdAt: Date.now(),
      contentType: expected.contentType,
    })
    return { opId, stagedKey: opId, bytes: total, sha256 }
  }

  async promote(staged: StagedBlob, finalKey: string): Promise<void> {
    this.promoteCount++
    if (this.promoteCount > this.failPromoteAfter) throw err('SK_STORAGE_FAULT', 500)
    const e = this.staging.get(staged.stagedKey)
    if (!e) {
      if (this.objects.has(finalKey)) return
      throw err('SK_STORAGE_PROMOTE_FAILED', 502)
    }
    this.objects.set(finalKey, e)
    this.staging.delete(staged.stagedKey)
  }

  async open(key: string, range?: ByteRange): Promise<BlobRead> {
    const e = this.objects.get(key)
    if (!e) throw err('SK_STORAGE_OBJECT_MISSING', 500)
    let start = 0
    let end = e.bytes.byteLength - 1
    if (range) {
      start = Math.max(0, range.start)
      end =
        range.end === null ? e.bytes.byteLength - 1 : Math.min(range.end, e.bytes.byteLength - 1)
      if (start > end || start >= e.bytes.byteLength)
        throw err('SK_STORAGE_RANGE_NOT_SATISFIABLE', 416)
    }
    const slice = e.bytes.slice(start, end + 1)
    return {
      stream: new Blob([slice]).stream(),
      totalBytes: e.bytes.byteLength,
      range: range ? { start, end } : null,
      sha256: e.sha256,
      contentType: e.contentType,
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const e = this.objects.get(key)
    if (!e) return null
    const iso = new Date(e.createdAt).toISOString()
    return {
      key,
      bytes: e.bytes.byteLength,
      sha256: e.sha256,
      contentType: e.contentType,
      createdAt: iso,
      updatedAt: iso,
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async *listStaged(olderThan: string): AsyncIterable<StagedBlob> {
    const cutoff = Date.parse(olderThan)
    for (const [opId, e] of this.staging) {
      if (e.createdAt < cutoff)
        yield { opId, stagedKey: opId, bytes: e.bytes.byteLength, sha256: e.sha256 }
    }
  }

  /** Test helper: forcibly drop an object's bytes (simulate corruption). */
  dropBytes(key: string): void {
    this.objects.delete(key)
  }

  keys(): string[] {
    return [...this.objects.keys()]
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

function err(code: string, httpStatus: number): Error {
  const e = new Error(code)
  ;(e as Error & { kernelError: unknown }).kernelError = {
    code,
    httpStatus,
    category: 'integrity',
    message: code,
    details: null,
    hint: null,
    retryable: false,
  }
  return e
}
