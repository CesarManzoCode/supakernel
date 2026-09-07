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

function segment(key: string): string {
  // OPFS names cannot contain '/'; store objects under a flat, hashed name + a sidecar meta.
  return `${key.replace(/[^A-Za-z0-9._-]/g, '_')}__${hashName(key)}`
}
function hashName(key: string): string {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

interface DirHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>
  entries(): AsyncIterable<[string, FileHandle | DirHandle]>
}
interface FileHandle {
  kind: 'file'
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: BufferSource): Promise<void>; close(): Promise<void> }>
}

/**
 * Browser OPFS `BlobAdapter` (contract §14). Staged bytes are written under `staging/`; only
 * `promote` moves them into `objects/`. Runs inside the browser WebWorker runtime profile.
 */
export class OpfsBlobAdapter implements BlobAdapter {
  readonly id: string
  private rootPromise: Promise<DirHandle>

  constructor(options: { root?: string; id?: string } = {}) {
    this.id = options.id ?? 'blob-opfs'
    const sub = options.root ?? 'sk-blob'
    this.rootPromise = (navigator.storage.getDirectory() as unknown as Promise<DirHandle>).then(
      (d) => d.getDirectoryHandle(sub, { create: true }),
    )
  }

  private async dir(name: 'staging' | 'objects'): Promise<DirHandle> {
    return (await this.rootPromise).getDirectoryHandle(name, { create: true })
  }

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
      if (total > expected.maxBytes)
        throw blobError('SK_STORAGE_TOO_LARGE', 'object exceeds the bucket size limit', 413)
      chunks.push(value)
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
    const fh = await (await this.dir('staging')).getFileHandle(opId, { create: true })
    const w = await fh.createWritable()
    await w.write(bytes)
    await w.close()
    return { opId, stagedKey: opId, bytes: total, sha256 }
  }

  async promote(staged: StagedBlob, finalKey: string): Promise<void> {
    const src = await (await this.dir('staging')).getFileHandle(staged.stagedKey).catch(() => null)
    const objects = await this.dir('objects')
    const name = segment(finalKey)
    if (!src) {
      if (
        await objects
          .getFileHandle(name)
          .then(() => true)
          .catch(() => false)
      )
        return
      throw blobError('SK_STORAGE_PROMOTE_FAILED', 'staged bytes are gone', 502)
    }
    const file = await src.getFile()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const dh = await objects.getFileHandle(name, { create: true })
    const w = await dh.createWritable()
    await w.write(bytes)
    await w.close()
    const mh = await objects.getFileHandle(`${name}.meta`, { create: true })
    const mw = await mh.createWritable()
    await mw.write(
      new TextEncoder().encode(
        JSON.stringify({
          bytes: staged.bytes,
          sha256: staged.sha256,
          createdAt: new Date().toISOString(),
        }),
      ),
    )
    await mw.close()
    await (await this.dir('staging')).removeEntry(staged.stagedKey).catch(() => undefined)
  }

  async open(key: string, range?: ByteRange): Promise<BlobRead> {
    const objects = await this.dir('objects')
    const fh = await objects.getFileHandle(segment(key)).catch(() => null)
    if (!fh) throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
    const file = await fh.getFile()
    const total = file.size
    let start = 0
    let end = total - 1
    if (range) {
      start = Math.max(0, range.start)
      end = range.end === null ? total - 1 : Math.min(range.end, total - 1)
      if (start > end || start >= total)
        throw blobError('SK_STORAGE_RANGE_NOT_SATISFIABLE', `bytes */${total}`, 416)
    }
    const slice = file.slice(start, end + 1)
    const meta = await this.readMeta(key)
    return {
      stream: slice.stream() as ReadableStream<Uint8Array>,
      totalBytes: total,
      range: range ? { start, end } : null,
      sha256: meta?.sha256 ?? '',
      contentType: null,
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const objects = await this.dir('objects')
    const fh = await objects.getFileHandle(segment(key)).catch(() => null)
    if (!fh) return null
    const file = await fh.getFile()
    const meta = await this.readMeta(key)
    return {
      key,
      bytes: file.size,
      sha256: meta?.sha256 ?? '',
      contentType: null,
      createdAt: meta?.createdAt ?? new Date(file.lastModified).toISOString(),
      updatedAt: new Date(file.lastModified).toISOString(),
    }
  }

  async delete(key: string): Promise<void> {
    const objects = await this.dir('objects')
    await objects.removeEntry(segment(key)).catch(() => undefined)
    await objects.removeEntry(`${segment(key)}.meta`).catch(() => undefined)
  }

  async *listStaged(olderThan: string): AsyncIterable<StagedBlob> {
    const cutoff = Date.parse(olderThan)
    const staging = await this.dir('staging')
    for await (const [name, handle] of staging.entries()) {
      if ((handle as FileHandle).kind !== 'file') continue
      const file = await (handle as FileHandle).getFile()
      if (file.lastModified < cutoff) {
        yield {
          opId: name,
          stagedKey: name,
          bytes: file.size,
          sha256: await sha256Hex(new Uint8Array(await file.arrayBuffer())),
        }
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {}

  private async readMeta(key: string): Promise<{ sha256: string; createdAt: string } | null> {
    const objects = await this.dir('objects')
    const fh = await objects.getFileHandle(`${segment(key)}.meta`).catch(() => null)
    if (!fh) return null
    const text = await (await fh.getFile()).text()
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
}

export function openOpfsBlob(options?: { root?: string; id?: string }): OpfsBlobAdapter {
  return new OpfsBlobAdapter(options)
}
