import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { kernelError } from '@supakernel/contracts'
import type {
  BlobAdapter,
  BlobExpectation,
  BlobRead,
  BlobStat,
  ByteRange,
  StagedBlob,
} from '@supakernel/ports'

export interface S3Config {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** MinIO / most S3-compatible stores need path-style addressing. Defaults to path-style. */
  readonly forcePathStyle?: boolean
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

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

function httpStatusOf(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
  return meta?.httpStatusCode
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatusOf(err) === 404
}

async function collect(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes)
      throw blobError('SK_STORAGE_TOO_LARGE', 'object exceeds the bucket size limit', 413)
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * S3 / R2 `BlobAdapter` (contract §14). Built on the pinned `@aws-sdk/client-s3` (§33.1) so
 * the request signing, retry and streaming paths are the SDK's. Works against AWS S3, MinIO
 * and Cloudflare R2 (path-style addressing on by default for S3-compatible endpoints).
 * Staged objects live under `staging/<opId>`; `promote` server-side-copies to the final key
 * and then deletes the staged object.
 */
export class S3BlobAdapter implements BlobAdapter {
  readonly id: string
  private readonly bucket: string
  private readonly client: S3Client

  constructor(cfg: S3Config & { id?: string; client?: S3Client }) {
    this.bucket = cfg.bucket
    this.id = cfg.id ?? `blob-s3:${cfg.endpoint}/${cfg.bucket}`
    const clientConfig: S3ClientConfig = {
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.forcePathStyle !== false,
    }
    this.client = cfg.client ?? new S3Client(clientConfig)
  }

  private stagedKey(opId: string): string {
    return `staging/${opId}`
  }

  async putStaged(
    opId: string,
    body: ReadableStream<Uint8Array>,
    expected: BlobExpectation,
  ): Promise<StagedBlob> {
    const bytes = await collect(body, expected.maxBytes)
    const sha256 = await sha256Hex(bytes)
    if (expected.sha256 && expected.sha256 !== sha256) {
      throw blobError(
        'SK_STORAGE_HASH_MISMATCH',
        'uploaded bytes do not match the expected digest',
        400,
      )
    }
    const key = this.stagedKey(opId)
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ...(expected.contentType ? { ContentType: expected.contentType } : {}),
        }),
      )
    } catch (err) {
      throw blobError(
        'SK_STORAGE_WRITE_FAILED',
        `staged write failed (${httpStatusOf(err) ?? (err as Error).name})`,
        502,
      )
    }
    return { opId, stagedKey: key, bytes: bytes.byteLength, sha256 }
  }

  async promote(staged: StagedBlob, finalKey: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: finalKey,
          CopySource: `${this.bucket}/${staged.stagedKey.split('/').map(encodeURIComponent).join('/')}`,
        }),
      )
    } catch (err) {
      // A missing staged object → tolerate if the final object already exists (idempotent replay).
      if (!isNotFound(err) || !(await this.stat(finalKey))) {
        throw blobError(
          'SK_STORAGE_PROMOTE_FAILED',
          `promote failed (${httpStatusOf(err) ?? (err as Error).name})`,
          502,
        )
      }
    }
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: staged.stagedKey }))
      .catch(() => undefined)
  }

  async open(key: string, range?: ByteRange): Promise<BlobRead> {
    let res: GetObjectCommandOutput
    try {
      res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range
            ? { Range: `bytes=${range.start}-${range.end === null ? '' : range.end}` }
            : {}),
        }),
      )
    } catch (err) {
      if ((err as { name?: string }).name === 'InvalidRange' || httpStatusOf(err) === 416)
        throw blobError('SK_STORAGE_RANGE_NOT_SATISFIABLE', 'range not satisfiable', 416)
      if (isNotFound(err))
        throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
      throw blobError('SK_STORAGE_READ_FAILED', `read failed (${(err as Error).name})`, 502)
    }
    const bodyStream = (
      res.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined
    )?.transformToWebStream?.()
    if (!bodyStream) throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
    const cr = res.ContentRange
    let outRange: { start: number; end: number } | null = null
    const m = cr ? /bytes (\d+)-(\d+)\//.exec(cr) : null
    if (m) outRange = { start: Number(m[1]), end: Number(m[2]) }
    const totalBytes = Number(cr?.split('/')[1] ?? res.ContentLength ?? 0)
    return {
      stream: bodyStream,
      totalBytes,
      range: outRange,
      sha256: (res.ETag ?? '').replace(/"/g, ''),
      contentType: res.ContentType ?? null,
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    let res: HeadObjectCommandOutput
    try {
      res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch (err) {
      if (isNotFound(err)) return null
      throw blobError(
        'SK_STORAGE_STAT_FAILED',
        `stat failed (${httpStatusOf(err) ?? (err as Error).name})`,
        502,
      )
    }
    const at = (res.LastModified ?? new Date()).toISOString()
    return {
      key,
      bytes: Number(res.ContentLength ?? 0),
      sha256: (res.ETag ?? '').replace(/"/g, ''),
      contentType: res.ContentType ?? null,
      createdAt: at,
      updatedAt: at,
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async *listStaged(olderThan: string): AsyncIterable<StagedBlob> {
    const cutoff = Date.parse(olderThan)
    let continuationToken: string | undefined
    do {
      const res: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: 'staging/',
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      )
      for (const obj of res.Contents ?? []) {
        const key = obj.Key ?? ''
        if (key && (obj.LastModified?.getTime() ?? 0) < cutoff) {
          yield {
            opId: key.replace(/^staging\//, ''),
            stagedKey: key,
            bytes: obj.Size ?? 0,
            sha256: '',
          }
        }
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (continuationToken)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.client.destroy()
  }
}

export function openS3Blob(cfg: S3Config & { id?: string }): S3BlobAdapter {
  return new S3BlobAdapter(cfg)
}
