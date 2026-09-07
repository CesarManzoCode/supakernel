import { createClient } from '@supabase/supabase-js'
import type { FixtureClient } from '@supakernel/fixture-app'
import type {
  ApiGatewayProxyEventV2,
  LambdaContext,
  LambdaHandler,
} from '@supakernel/runtime-lambda'

const ctx: LambdaContext = {
  awsRequestId: 'rtm-lambda',
  getRemainingTimeInMillis: () => 29_000,
}

/** A `fetch` that drives a Lambda proxy handler exactly as API Gateway HTTP API v2 would. */
export function lambdaFetch(handler: LambdaHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request && !init
        ? input
        : new Request(
            typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
            init,
          )
    const url = new URL(request.url)
    const rawBody = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : new Uint8Array(await request.arrayBuffer())
    const headers: Record<string, string> = {}
    for (const [k, v] of request.headers) headers[k] = v
    headers.host = url.host
    const event: ApiGatewayProxyEventV2 = {
      version: '2.0',
      rawPath: url.pathname,
      rawQueryString: url.search.replace(/^\?/, ''),
      headers,
      requestContext: { http: { method: request.method }, domainName: url.host },
      ...(rawBody && rawBody.byteLength > 0
        ? { body: Buffer.from(rawBody).toString('base64'), isBase64Encoded: true }
        : {}),
    }
    const result = await handler(event, ctx)
    const body = result.isBase64Encoded
      ? Buffer.from(result.body, 'base64')
      : new TextEncoder().encode(result.body)
    return new Response(result.body === '' ? null : body, {
      status: result.statusCode,
      headers: result.headers,
    })
  }) as typeof fetch
}

export function lambdaFixtureClient(
  baseUrl: string,
  anonKey: string,
  handler: LambdaHandler,
): FixtureClient {
  return createClient(baseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: lambdaFetch(handler) },
  }) as unknown as FixtureClient
}
