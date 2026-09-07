import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat as fsStat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
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

/** A safe on-disk path for an opaque storage key — never escapes the root. */
function safeSegment(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Filesystem `BlobAdapter` (contract §14). Bytes land in `staging/` first; only `promote`
 * moves them under `objects/`. Hash + size are computed while streaming and verified before
 * the staged blob is returned.
 */
export class FsBlobAdapter implements BlobAdapter {
  readonly id: string
  private readonly root: string

  constructor(options: { root: string; id?: string }) {
    this.root = options.root
    this.id = options.id ?? `blob-fs:${options.root}`
  }

  private staged(opId: string): string {
    return join(this.root, 'staging', safeSegment(opId))
  }
  private object(key: string): string {
    return join(this.root, 'objects', safeSegment(key))
  }
  private meta(key: string): string {
    return `${this.object(key)}.meta.json`
  }

  async putStaged(
    opId: string,
    body: ReadableStream<Uint8Array>,
    expected: BlobExpectation,
  ): Promise<StagedBlob> {
    const stagedKey = this.staged(opId)
    await mkdir(dirname(stagedKey), { recursive: true })
    const hash = createHash('sha256')
    let bytes = 0
    const out = createWriteStream(stagedKey)
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > expected.maxBytes) {
          out.destroy()
          await rm(stagedKey, { force: true })
          throw blobError('SK_STORAGE_TOO_LARGE', 'object exceeds the bucket size limit', 413)
        }
        hash.update(value)
        await new Promise<void>((resolve, reject) => out.write(value, (err) => (err ? reject(err) : resolve())))
      }
    } finally {
      reader.releaseLock()
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    const sha256 = hash.digest('hex')
    if (expected.sha256 && expected.sha256 !== sha256) {
      await rm(stagedKey, { force: true })
      throw blobError('SK_STORAGE_HASH_MISMATCH', 'uploaded bytes do not match the expected digest', 400)
    }
    return { opId, stagedKey, bytes, sha256 }
  }

  async promote(staged: StagedBlob, finalKey: string): Promise<void> {
    const dest = this.object(finalKey)
    await mkdir(dirname(dest), { recursive: true })
    try {
      await rename(staged.stagedKey, dest)
    } catch (err) {
      // idempotent: the staged file is already gone but the object exists → treat as done
      if (await this.exists(dest)) return
      throw err
    }
    const { writeFile } = await import('node:fs/promises')
    const now = new Date().toISOString()
    await writeFile(
      this.meta(finalKey),
      JSON.stringify({ bytes: staged.bytes, sha256: staged.sha256, createdAt: now, updatedAt: now }),
    )
  }

  async open(key: string, range?: ByteRange): Promise<BlobRead> {
    const path = this.object(key)
    let info: Awaited<ReturnType<typeof fsStat>>
    try {
      info = await fsStat(path)
    } catch {
      throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
    }
    const total = info.size
    const meta = await this.readMeta(key)
    let start = 0
    let end = total - 1
    if (range) {
      start = Math.max(0, range.start)
      end = range.end === null ? total - 1 : Math.min(range.end, total - 1)
      if (start > end || start >= total) {
        throw blobError('SK_STORAGE_RANGE_NOT_SATISFIABLE', `bytes */${total}`, 416)
      }
    }
    const nodeStream = createReadStream(path, { start, end })
    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      totalBytes: total,
      range: range ? { start, end } : null,
      sha256: meta?.sha256 ?? '',
      contentType: null,
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const path = this.object(key)
    if (!(await this.exists(path))) return null
    const info = await fsStat(path)
    const meta = await this.readMeta(key)
    return {
      key,
      bytes: info.size,
      sha256: meta?.sha256 ?? '',
      contentType: null,
      createdAt: meta?.createdAt ?? info.birthtime.toISOString(),
      updatedAt: meta?.updatedAt ?? info.mtime.toISOString(),
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.object(key), { force: true })
    await rm(this.meta(key), { force: true })
  }

  async *listStaged(olderThan: string): AsyncIterable<StagedBlob> {
    const dir = join(this.root, 'staging')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    const cutoff = Date.parse(olderThan)
    for (const name of names) {
      const full = join(dir, name)
      const info = await fsStat(full)
      if (info.mtimeMs < cutoff) {
        const buf = await import('node:fs/promises').then((m) => m.readFile(full))
        yield {
          opId: name,
          stagedKey: full,
          bytes: info.size,
          sha256: createHash('sha256').update(buf).digest('hex'),
        }
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {}

  private async exists(p: string): Promise<boolean> {
    try {
      await fsStat(p)
      return true
    } catch {
      return false
    }
  }

  private async readMeta(
    key: string,
  ): Promise<{ bytes: number; sha256: string; createdAt: string; updatedAt: string } | null> {
    try {
      const text = await import('node:fs/promises').then((m) => m.readFile(this.meta(key), 'utf8'))
      return JSON.parse(text)
    } catch {
      return null
    }
  }
}

export function openFsBlob(options: { root: string; id?: string }): FsBlobAdapter {
  return new FsBlobAdapter(options)
}
