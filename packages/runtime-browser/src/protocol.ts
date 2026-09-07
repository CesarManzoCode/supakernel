/**
 * The MessageChannel wire between the page and the SupaKernel WebWorker (contract §10 —
 * "Browser expone un `fetch(request)` mediante `MessageChannel`; no se finge un socket").
 */
export interface WireRequest {
  readonly kind: 'sk-request'
  readonly id: number
  readonly url: string
  readonly method: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body: ArrayBuffer | null
}

export interface WireResponse {
  readonly kind: 'sk-response'
  readonly id: number
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: ArrayBuffer | null
  readonly error?: string
}

export interface WireReady {
  readonly kind: 'sk-ready'
}

export type WireMessage = WireRequest | WireResponse | WireReady

export async function encodeRequest(id: number, request: Request): Promise<WireRequest> {
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer()
  return {
    kind: 'sk-request',
    id,
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body: body && body.byteLength > 0 ? body : null,
  }
}

export async function encodeResponse(id: number, response: Response): Promise<WireResponse> {
  const body = await response.arrayBuffer()
  return {
    kind: 'sk-response',
    id,
    status: response.status,
    headers: [...response.headers.entries()],
    body: body.byteLength > 0 ? body : null,
  }
}

export function decodeResponse(msg: WireResponse): Response {
  if (msg.error) throw new Error(msg.error)
  return new Response(msg.body, {
    status: msg.status,
    headers: new Headers(msg.headers as [string, string][]),
  })
}

export function decodeRequest(msg: WireRequest): Request {
  return new Request(msg.url, {
    method: msg.method,
    headers: new Headers(msg.headers as [string, string][]),
    ...(msg.body ? { body: msg.body } : {}),
  })
}
