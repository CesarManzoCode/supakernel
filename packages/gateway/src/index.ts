// SupaKernel gateway — Hono routing + middleware ONLY (contract §6.2, §30 L9). No domain
// logic, no SQL, no authorization: every request is decoded, size/CORS-checked and forwarded
// to a kernel handler; the response is passed straight back.

import type { KernelInstance } from '@supakernel/kernel'
import { Hono } from 'hono'

export interface GatewayOptions {
  readonly kernel: KernelInstance
  /** Exact CORS allowlist — no credentialed wildcard (contract §25). */
  readonly corsOrigins?: readonly string[]
  /** Max request body in bytes (contract §10 default 10 MiB for Data/Auth). */
  readonly maxBodyBytes?: number
  /** When false, a non-loopback plain-HTTP request is refused at startup (handled by the runtime). */
  readonly devInsecure?: boolean
}

const DEFAULT_MAX_BODY = 10 * 1024 * 1024

export function createGateway(options: GatewayOptions): Hono {
  const app = new Hono()
  const { kernel } = options
  const origins = new Set(options.corsOrigins ?? [])
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY

  const applyCors = (headers: Headers, origin: string): void => {
    headers.set('access-control-allow-origin', origin)
    headers.set('vary', 'Origin')
    headers.set(
      'access-control-allow-headers',
      'authorization, apikey, content-type, prefer, x-upsert, range',
    )
    headers.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS')
  }

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    const allowed = Boolean(origin && origins.has(origin))

    if (c.req.method === 'OPTIONS') {
      const res = new Response(null, { status: 204 })
      if (allowed && origin) applyCors(res.headers, origin)
      return res
    }
    const len = Number(c.req.header('content-length') ?? '0')
    if (len > maxBody) {
      const res = new Response(
        JSON.stringify({ message: 'request body too large', code: 'SK_BODY_TOO_LARGE' }),
        {
          status: 413,
          headers: { 'content-type': 'application/json' },
        },
      )
      if (allowed && origin) applyCors(res.headers, origin)
      return res
    }
    await next()
    if (allowed && origin) applyCors(c.res.headers, origin)
    return undefined
  })

  const forward =
    (pick: (k: KernelInstance) => (r: Request) => Promise<Response>) =>
    async (c: { req: { raw: Request } }) => {
      try {
        return await pick(kernel)(c.req.raw)
      } catch {
        return new Response(JSON.stringify({ message: 'internal error', code: 'SK_INTERNAL' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

  app.all(
    '/rest/v1/*',
    forward((k) => k.data),
  )
  app.get(
    '/rest/v1/',
    forward((k) => k.data),
  )
  app.all(
    '/auth/v1/*',
    forward((k) => k.auth),
  )
  app.all(
    '/storage/v1/*',
    forward((k) => k.storage),
  )
  app.all(
    '/v1/*',
    forward((k) => k.management),
  )
  app.get(
    '/_system/*',
    forward((k) => k.management),
  )
  app.get(
    '/.well-known/*',
    forward((k) => k.management),
  )

  app.get('/realtime/v1/websocket', (c) =>
    c.json(
      {
        message: 'WebSocket upgrade is handled by the runtime adapter, not the gateway',
        code: 'SK_RT_UPGRADE_RUNTIME',
      },
      426,
    ),
  )

  app.notFound((c) => c.json({ message: 'not found', code: 'SK_NOT_FOUND' }, 404))
  return app
}
