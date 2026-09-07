import { type Json, redactError } from '@supakernel/contracts'
import type { Principal } from '@supakernel/contracts'
import { STORAGE_ERRORS, StorageError } from './errors.js'
import { parseRangeHeader } from './range.js'
import type { ObjectInfo, StorageService } from './service.js'

export interface StorageHandlerDeps {
  readonly service: StorageService
  resolvePrincipal(headers: Headers): Principal | Promise<Principal>
}

const BASE = /^\/?(storage\/v1\/?)?/

/**
 * A `fetch`-shaped Storage handler (contract §14, §30 L7) that `@supabase/storage-js` points at
 * via a custom fetch. Nothing here imports Hono or an adapter.
 */
export function createStorageHandler(deps: StorageHandlerDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(BASE, '').replace(/\/$/, '')
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
    const method = request.method.toUpperCase()
    try {
      return await route(deps, request, url, seg, method)
    } catch (err) {
      if (err instanceof StorageError) {
        const ke = redactError(err.kernelError)
        return json(ke.httpStatus, { statusCode: String(ke.httpStatus), error: ke.code, message: ke.message })
      }
      const ke = redactError({ category: 'internal', code: 'SK_INTERNAL', message: 'internal error', details: null, hint: null, httpStatus: 500, retryable: true })
      return json(ke.httpStatus, { statusCode: '500', error: 'internal', message: ke.message })
    }
  }
}

async function route(
  deps: StorageHandlerDeps,
  request: Request,
  url: URL,
  seg: string[],
  method: string,
): Promise<Response> {
  const [root, ...rest] = seg
  const principal = () => deps.resolvePrincipal(request.headers)

  if (root === 'bucket') return bucketRoutes(deps, request, rest, method, principal)
  if (root === 'object') return objectRoutes(deps, request, url, rest, method, principal)
  throw STORAGE_ERRORS.unsupported(`${method} /${seg.join('/')}`)
}

async function bucketRoutes(
  deps: StorageHandlerDeps,
  request: Request,
  rest: string[],
  method: string,
  principal: () => Principal | Promise<Principal>,
): Promise<Response> {
  const s = deps.service
  const [name, sub] = rest
  if (method === 'GET' && !name) return json(200, (await s.listBuckets()) as unknown as Json)
  if (method === 'GET' && name) return json(200, (await s.getBucket(name)) as unknown as Json)
  if (method === 'POST' && !name) {
    const b = await body(request)
    const created = await s.createBucket(await principal(), {
      name: str(b.name ?? b.id),
      public: b.public === true,
      fileSizeLimit: numOrNull(b.file_size_limit),
      allowedMimeTypes: (b.allowed_mime_types as string[] | undefined) ?? null,
    })
    return json(200, { name: created.name } as unknown as Json)
  }
  if (method === 'PUT' && name) {
    const b = await body(request)
    await s.updateBucket(name, {
      public: b.public === true,
      fileSizeLimit: numOrNull(b.file_size_limit),
      allowedMimeTypes: (b.allowed_mime_types as string[] | undefined) ?? null,
    })
    return json(200, { message: 'Successfully updated' })
  }
  if (method === 'POST' && name && sub === 'empty') {
    await s.emptyBucket(name)
    return json(200, { message: 'Successfully emptied' })
  }
  if (method === 'DELETE' && name) {
    await s.deleteBucket(name)
    return json(200, { message: 'Successfully deleted' })
  }
  throw STORAGE_ERRORS.unsupported(`${method} bucket`)
}

async function objectRoutes(
  deps: StorageHandlerDeps,
  request: Request,
  url: URL,
  rest: string[],
  method: string,
  principal: () => Principal | Promise<Principal>,
): Promise<Response> {
  const s = deps.service
  const [kind, ...tail] = rest
  const range = parseRangeHeader(request.headers.get('range'))

  // GET /object/authenticated/:bucket/*path  |  /object/public/:bucket/*path  |  /object/sign/:bucket/*path?token=
  if (method === 'GET' && (kind === 'authenticated' || kind === 'public' || kind === 'sign')) {
    const [bucket, ...pathParts] = tail
    const path = pathParts.join('/')
    if (kind === 'public') return serve(await s.publicDownload(str(bucket), path, range ?? undefined), range)
    if (kind === 'sign') {
      const token = url.searchParams.get('token') ?? ''
      return serve(await s.downloadSigned(str(bucket), path, token, range ?? undefined), range)
    }
    return serve(await s.download(await principal(), str(bucket), path, range ?? undefined), range)
  }

  if (method === 'GET' && kind === 'info' && tail[0] === 'authenticated') {
    const [, bucket, ...pathParts] = tail
    const info = await s.objectInfoFor(await principal(), str(bucket), pathParts.join('/'))
    return json(200, info as unknown as Json)
  }

  if (method === 'POST' && kind === 'list') {
    const bucket = tail[0]
    const b = await body(request)
    const opts: { limit?: number; offset?: number } = {}
    const lim = num(b.limit)
    const off = num(b.offset)
    if (lim !== undefined) opts.limit = lim
    if (off !== undefined) opts.offset = off
    const items = await s.list(await principal(), str(bucket), str(b.prefix ?? ''), opts)
    return json(200, items as unknown as Json)
  }

  if (method === 'POST' && (kind === 'move' || kind === 'copy')) {
    const b = await body(request)
    const bucket = str(b.bucketId)
    if (kind === 'copy') {
      const info = await s.copy(await principal(), bucket, str(b.sourceKey), str(b.destinationKey))
      return json(200, { Key: `${bucket}/${info.name}` })
    }
    await s.move(await principal(), bucket, str(b.sourceKey), str(b.destinationKey))
    return json(200, { message: 'Successfully moved' })
  }

  if (method === 'POST' && kind === 'sign') {
    const [bucket, ...pathParts] = tail
    const b = await body(request)
    if (pathParts.length === 0 && Array.isArray(b.paths)) {
      const out = await s.createSignedUrls(await principal(), str(bucket), b.paths as string[], num(b.expiresIn) ?? 60)
      return json(200, out as unknown as Json)
    }
    const { signedURL } = await s.createSignedUrl(await principal(), str(bucket), pathParts.join('/'), num(b.expiresIn) ?? 60)
    return json(200, { signedURL })
  }

  // upload / upsert: POST|PUT /object/:bucket/*path
  if (method === 'POST' || method === 'PUT') {
    const [bucket, ...pathParts] = rest
    const path = pathParts.join('/')
    const upsert = method === 'PUT' || request.headers.get('x-upsert') === 'true'
    const stream = await bodyStream(request)
    const info = await s.upload(await principal(), str(bucket), path, stream, {
      contentType: request.headers.get('content-type'),
      cacheControl: cacheControl(request.headers.get('cache-control')),
      upsert,
    })
    return json(200, { Id: info.id, Key: `${str(bucket)}/${path}`, path } as unknown as Json)
  }

  if (method === 'DELETE') {
    const [bucket, ...pathParts] = rest
    await s.remove(await principal(), str(bucket), pathParts.join('/'))
    return json(200, { message: 'Successfully deleted' })
  }

  throw STORAGE_ERRORS.unsupported(`${method} object`)
}

async function serve(
  r: { stream: ReadableStream<Uint8Array>; info: ObjectInfo; range: { start: number; end: number } | null; total: number },
  requested: ReturnType<typeof parseRangeHeader>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': r.info.content_type ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    etag: `"${r.info.metadata && typeof r.info.metadata === 'object' ? '' : ''}"`,
  }
  if (r.info.cache_control) headers['cache-control'] = r.info.cache_control
  if (requested && r.range) {
    headers['content-range'] = `bytes ${r.range.start}-${r.range.end}/${r.total}`
    headers['content-length'] = String(r.range.end - r.range.start + 1)
    return new Response(r.stream, { status: 206, headers })
  }
  headers['content-length'] = String(r.total)
  return new Response(r.stream, { status: 200, headers })
}

async function bodyStream(request: Request): Promise<ReadableStream<Uint8Array>> {
  const ct = request.headers.get('content-type') ?? ''
  if (ct.startsWith('multipart/form-data')) {
    const form = await request.formData()
    const file = form.get('file') ?? form.get('') ?? [...form.values()][0]
    if (file instanceof Blob) return file.stream()
    return new Blob([String(file ?? '')]).stream()
  }
  if (request.body) return request.body
  const buf = await request.arrayBuffer()
  return new Blob([buf]).stream()
}

async function body(request: Request): Promise<Record<string, Json>> {
  const text = await request.text().catch(() => '')
  if (!text) return {}
  try {
    const v = JSON.parse(text) as Json
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {}
  } catch {
    return {}
  }
}

function cacheControl(v: string | null): string | null {
  if (!v) return 'max-age=3600'
  return v.startsWith('max-age') || v.startsWith('no-cache') ? v : `max-age=${v}`
}
function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}
function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && v !== null && v !== undefined && v !== '' ? n : null
}
function json(status: number, b: Json): Response {
  return new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
