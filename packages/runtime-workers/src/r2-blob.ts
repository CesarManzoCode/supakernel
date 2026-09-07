import { kernelError } from '@supakernel/contracts'
import type {
  BlobAdapter,
  BlobExpectation,
  BlobRead,
  BlobStat,
  ByteRange,
  StagedBlob,
} from '@supakernel/ports'

function blobError(code: string, message: string, httpStatus: number): Error {
  const e = new Error(`${code}: ${message}`)
  ;(e as Error & { kernelError: unknown }).kernelError = kernelError({
    category: httpStatus === 413 ? 'input' : httpStatus === 404 ? 'not_found' : 'integrity',
    code,
    message,
    httpStatus,
  })
  return e
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const STAGING = 'staging/'
const OBJECTS = 'objects/'

/**
 * Cloudflare R2 `BlobAdapter` (contract §14) for the Workers runtime profile. Staged bytes live
 * under `staging/`; `promote` copies them to `objects/` and deletes the staged key. Digest and
 * size are verified in `putStaged`, exactly as the FS adapter does. Workers have no filesystem,
 * so this is the only blob backend for the profile.
 */
export class R2BlobAdapter implements BlobAdapter {
  readonly id: string
  private readonly bucket: R2Bucket

  constructor(options: { bucket: R2Bucket; id?: string }) {
    this.bucket = options.bucket
    this.id = options.id ?? 'blob-r2'
  }

  async putStaged(
    opId: string,
    body: ReadableStream<Uint8Array>,
    expected: BlobExpectation,
  ): Promise<StagedBlob> {
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > expected.maxBytes) {
          throw blobError('SK_STORAGE_TOO_LARGE', 'object exceeds the bucket size limit', 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      bytes.set(c, off)
      off += c.byteLength
    }
    const sha256 = await sha256Hex(bytes)
    if (expected.sha256 && expected.sha256 !== sha256) {
      throw blobError(
        'SK_STORAGE_HASH_MISMATCH',
        'uploaded bytes do not match the expected digest',
        400,
      )
    }
    await this.bucket.put(`${STAGING}${opId}`, bytes, {
      customMetadata: { bytes: String(total), sha256 },
    })
    return { opId, stagedKey: opId, bytes: total, sha256 }
  }

  async promote(staged: StagedBlob, finalKey: string): Promise<void> {
    const src = await this.bucket.get(`${STAGING}${staged.stagedKey}`)
    if (!src) {
      if (await this.bucket.head(`${OBJECTS}${finalKey}`)) return
      throw blobError('SK_STORAGE_PROMOTE_FAILED', 'staged bytes are gone', 502)
    }
    const now = new Date().toISOString()
    await this.bucket.put(`${OBJECTS}${finalKey}`, await src.arrayBuffer(), {
      customMetadata: {
        bytes: String(staged.bytes),
        sha256: staged.sha256,
        createdAt: now,
        updatedAt: now,
      },
    })
    await this.bucket.delete(`${STAGING}${staged.stagedKey}`)
  }

  async open(key: string, range?: ByteRange): Promise<BlobRead> {
    const head = await this.bucket.head(`${OBJECTS}${key}`)
    if (!head) throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
    const total = head.size
    let start = 0
    let end = total - 1
    let getOpts: R2GetOptions | undefined
    if (range) {
      start = Math.max(0, range.start)
      end = range.end === null ? total - 1 : Math.min(range.end, total - 1)
      if (start > end || start >= total) {
        throw blobError('SK_STORAGE_RANGE_NOT_SATISFIABLE', `bytes */${total}`, 416)
      }
      getOpts = { range: { offset: start, length: end - start + 1 } }
    }
    const obj = await this.bucket.get(`${OBJECTS}${key}`, getOpts)
    if (!obj) throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
    return {
      stream: obj.body,
      totalBytes: total,
      range: range ? { start, end } : null,
      sha256: head.customMetadata?.sha256 ?? '',
      contentType: head.httpMetadata?.contentType ?? null,
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const head = await this.bucket.head(`${OBJECTS}${key}`)
    if (!head) return null
    const m = head.customMetadata ?? {}
    return {
      key,
      bytes: head.size,
      sha256: m.sha256 ?? '',
      contentType: head.httpMetadata?.contentType ?? null,
      createdAt: m.createdAt ?? head.uploaded.toISOString(),
      updatedAt: m.updatedAt ?? head.uploaded.toISOString(),
    }
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(`${OBJECTS}${key}`)
  }

  async *listStaged(olderThan: string): AsyncIterable<StagedBlob> {
    const cutoff = Date.parse(olderThan)
    let cursor: string | undefined
    for (;;) {
      const page = await this.bucket.list(
        cursor === undefined ? { prefix: STAGING } : { prefix: STAGING, cursor },
      )
      for (const o of page.objects) {
        if (o.uploaded.getTime() >= cutoff) continue
        const m = o.customMetadata ?? {}
        yield {
          opId: o.key.slice(STAGING.length),
          stagedKey: o.key.slice(STAGING.length),
          bytes: Number(m.bytes ?? o.size),
          sha256: m.sha256 ?? '',
        }
      }
      if (!page.truncated || !page.cursor) break
      cursor = page.cursor
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export function openR2Blob(options: { bucket: R2Bucket; id?: string }): R2BlobAdapter {
  return new R2BlobAdapter(options)
}
