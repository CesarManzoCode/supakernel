/**
 * AWS Lambda adapter (contract §10 — "AWS Node 24 container pin"; Data / Auth / Storage /
 * health over PG + S3; no Realtime WebSocket, no local filesystem durability). Converts an API
 * Gateway HTTP API v2 (payload format 2.0) proxy event into a Web `Request`, runs the composed
 * gateway handler and serialises the `Response` back.
 */
export type WebHandler = (request: Request) => Promise<Response> | Response

export interface ApiGatewayProxyEventV2 {
  readonly version: '2.0'
  readonly rawPath: string
  readonly rawQueryString: string
  readonly headers: Record<string, string | undefined>
  readonly requestContext: {
    readonly http: { readonly method: string }
    readonly domainName?: string
  }
  readonly body?: string
  readonly isBase64Encoded?: boolean
}

export interface ApiGatewayProxyResultV2 {
  readonly statusCode: number
  readonly headers: Record<string, string>
  readonly body: string
  readonly isBase64Encoded: boolean
}

export interface LambdaContext {
  readonly awsRequestId: string
  getRemainingTimeInMillis(): number
}

export type LambdaHandler = (
  event: ApiGatewayProxyEventV2,
  context: LambdaContext,
) => Promise<ApiGatewayProxyResultV2>

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml)|application\/[a-z.+-]*\+json)/i

function eventToRequest(event: ApiGatewayProxyEventV2): Request {
  const host = event.headers.host ?? event.requestContext.domainName ?? 'lambda.local'
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : ''
  const url = `https://${host}${event.rawPath}${qs}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v)
  const method = event.requestContext.http.method
  if (method === 'GET' || method === 'HEAD' || event.body === undefined) {
    return new Request(url, { method, headers })
  }
  const body = event.isBase64Encoded
    ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(event.body)
  return new Request(url, { method, headers, body })
}

async function responseToResult(response: Response): Promise<ApiGatewayProxyResultV2> {
  const headers: Record<string, string> = {}
  for (const [key, value] of response.headers) headers[key] = value
  const contentType = response.headers.get('content-type') ?? ''
  const buffer = new Uint8Array(await response.arrayBuffer())
  const isText = TEXT_TYPES.test(contentType)
  return {
    statusCode: response.status,
    headers,
    isBase64Encoded: !isText,
    body: isText ? new TextDecoder().decode(buffer) : toBase64(buffer),
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Wrap a Web `fetch` handler as a Lambda proxy handler. */
export function createLambdaHandler(fetchHandler: WebHandler): LambdaHandler {
  return async (event) => {
    try {
      const response = await fetchHandler(eventToRequest(event))
      return await responseToResult(response)
    } catch (err) {
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        isBase64Encoded: false,
        body: JSON.stringify({
          message: 'internal error',
          code: 'SK_INTERNAL',
          detail: (err as Error).message,
        }),
      }
    }
  }
}
