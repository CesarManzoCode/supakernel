import { kernelError } from '@supakernel/contracts'
import type {
  BlobAdapter,
  BlobExpectation,
  BlobRead,
  BlobStat,
  ByteRange,
  StagedBlob,
} from '@supakernel/ports'
import { type S3Config, sha256Hex, signS3 } from './sigv4.js'

export type { S3Config } from './sigv4.js'

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
 * S3 / R2 `BlobAdapter` (contract §14). Talks the S3 REST API with self-contained SigV4
 * signing (WebCrypto) — no SDK. Staged objects are stored under `staging/<opId>`; `promote`
 * server-side-copies to the final key, then deletes the staged object.
 */
export class S3BlobAdapter implements BlobAdapter {
  readonly id: string
  private readonly cfg: S3Config

  constructor(cfg: S3Config & { id?: string }) {
    this.cfg = cfg
    this.id = cfg.id ?? `blob-s3:${cfg.endpoint}/${cfg.bucket}`
  }

  private stagedKey(opId: string): string {
    return `staging/${opId}`
  }

  private async request(
    method: string,
    key: string,
    payload: Uint8Array | null,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const payloadHash = payload
      ? await sha256Hex(payload)
      : method === 'GET' || method === 'HEAD'
        ? 'UNSIGNED-PAYLOAD'
        : await sha256Hex('')
    const headers = { ...extraHeaders }
    if (payload) headers['content-length'] = String(payload.byteLength)
    const signed = await signS3(this.cfg, method, key, payloadHash, headers)
    const init: RequestInit = { method, headers: signed.headers }
    if (payload) init.body = Uint8Array.from(payload) as unknown as BodyInit
    return fetch(signed.url, init)
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
    const res = await this.request('PUT', key, bytes, {
      ...(expected.contentType ? { 'content-type': expected.contentType } : {}),
    })
    if (!res.ok)
      throw blobError('SK_STORAGE_WRITE_FAILED', `staged write failed (${res.status})`, 502)
    return { opId, stagedKey: key, bytes: bytes.byteLength, sha256 }
  }

  async promote(staged: StagedBlob, finalKey: string): Promise<void> {
    const copySource = `/${this.cfg.bucket}/${staged.stagedKey.split('/').map(encodeURIComponent).join('/')}`
    const res = await this.request('PUT', finalKey, new Uint8Array(0), {
      'x-amz-copy-source': copySource,
    })
    if (!res.ok && res.status !== 404) {
      // 404 → staged already moved (idempotent replay); tolerate if the object now exists
      if (!(await this.stat(finalKey))) {
        throw blobError('SK_STORAGE_PROMOTE_FAILED', `promote failed (${res.status})`, 502)
      }
    }
    await this.request('DELETE', staged.stagedKey, new Uint8Array(0)).catch(() => undefined)
  }

  async open(key: string, range?: ByteRange): Promise<BlobRead> {
    const headers: Record<string, string> = {}
    if (range) {
      headers.range = `bytes=${range.start}-${range.end === null ? '' : range.end}`
    }
    const res = await this.request('GET', key, null, headers)
    if (res.status === 416)
      throw blobError('SK_STORAGE_RANGE_NOT_SATISFIABLE', 'range not satisfiable', 416)
    if (res.status === 404 || !res.body)
      throw blobError('SK_STORAGE_OBJECT_MISSING', 'object bytes are missing', 500)
    const totalBytes = Number(
      res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length') ?? 0,
    )
    let outRange: { start: number; end: number } | null = null
    const cr = res.headers.get('content-range')
    if (cr) {
      const m = /bytes (\d+)-(\d+)\//.exec(cr)
      if (m) outRange = { start: Number(m[1]), end: Number(m[2]) }
    }
    return {
      stream: res.body,
      totalBytes,
      range: outRange,
      sha256: (res.headers.get('etag') ?? '').replace(/"/g, ''),
      contentType: res.headers.get('content-type'),
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const res = await this.request('HEAD', key, null)
    if (res.status === 404) return null
    if (!res.ok) throw blobError('SK_STORAGE_STAT_FAILED', `stat failed (${res.status})`, 502)
    const now = res.headers.get('last-modified') ?? new Date().toISOString()
    return {
      key,
      bytes: Number(res.headers.get('content-length') ?? 0),
      sha256: (res.headers.get('etag') ?? '').replace(/"/g, ''),
      contentType: res.headers.get('content-type'),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
  }

  async delete(key: string): Promise<void> {
    await this.request('DELETE', key, new Uint8Array(0))
  }

  async *listStaged(olderThan: string): AsyncIterable<StagedBlob> {
    const cutoff = Date.parse(olderThan)
    const signed = await signS3(
      this.cfg,
      'GET',
      '',
      'UNSIGNED-PAYLOAD',
      {},
      { 'list-type': '2', prefix: 'staging/' },
    )
    const res = await fetch(signed.url, { method: 'GET', headers: signed.headers })
    if (!res.ok) return
    const xml = await res.text()
    const entries = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
    for (const m of entries) {
      const body = m[1] ?? ''
      const key = /<Key>([^<]*)<\/Key>/.exec(body)?.[1] ?? ''
      const lastMod = /<LastModified>([^<]*)<\/LastModified>/.exec(body)?.[1] ?? ''
      const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? '0')
      if (key && Date.parse(lastMod) < cutoff) {
        yield { opId: key.replace(/^staging\//, ''), stagedKey: key, bytes: size, sha256: '' }
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export function openS3Blob(cfg: S3Config & { id?: string }): S3BlobAdapter {
  return new S3BlobAdapter(cfg)
}
