/** Minimal AWS SigV4 request signing over WebCrypto (contract §14 — real S3 REST, no SDK). */

export interface S3Config {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** MinIO / most S3-compatible stores need path-style addressing. */
  readonly forcePathStyle?: boolean
}

const enc = new TextEncoder()

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(data))
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const buf = typeof bytes === 'string' ? enc.encode(bytes) : Uint8Array.from(bytes)
  return hex(await crypto.subtle.digest('SHA-256', buf))
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
}

/** Sign an S3 request. `key` is the object key (already URL-safe path segments). */
export async function signS3(
  cfg: S3Config,
  method: string,
  key: string,
  payloadHash: string,
  extraHeaders: Record<string, string> = {},
  query: Record<string, string> = {},
): Promise<SignedRequest> {
  const base = new URL(cfg.endpoint)
  const host = base.host
  const canonicalUri = `/${cfg.forcePathStyle === false ? '' : `${cfg.bucket}/`}${key.split('/').map(encodeURIComponent).join('/')}`.replace('//', '/')
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${String(headers[k]).trim()}\n`)
    .join('')
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] as string)}`)
    .join('&')

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = await hmac(enc.encode(`AWS4${cfg.secretAccessKey}`), dateStamp)
  const kRegion = await hmac(kDate, cfg.region)
  const kService = await hmac(kRegion, 's3')
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = hex(await hmac(kSigning, stringToSign))

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const url = `${base.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`
  return { url, method, headers }
}
