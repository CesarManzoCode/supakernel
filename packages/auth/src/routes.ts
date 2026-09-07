import { type Json, redactError } from '@supakernel/contracts'
import { resolveApiKey } from './apikeys.js'
import { AuthError, type AuthErrorBody, authErrorBody } from './errors.js'
import type { AuthService } from './service.js'

const BASE = /^\/?(auth\/v1\/?)?/

interface Ctx {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly headers: Headers
  readonly body: Json
  readonly ipClass: string
}

interface RouteResult {
  status: number
  body: Json
  headers?: Record<string, string>
}

/**
 * A `fetch`-shaped GoTrue-subset handler (contract §12, §30 L6). `@supabase/supabase-js`'s auth
 * client points here via a custom fetch. Nothing here imports Hono.
 */
export function createAuthHandler(service: AuthService): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(BASE, '').replace(/\/$/, '')
    const ctx: Ctx = {
      method: request.method.toUpperCase(),
      path,
      query: url.searchParams,
      headers: request.headers,
      body: await readBody(request),
      ipClass: request.headers.get('x-sk-ip-class') ?? 'private',
    }
    try {
      await requireApiKey(service, ctx)
      const result = await dispatch(service, ctx)
      return json(result.status, result.body, result.headers)
    } catch (err) {
      if (err instanceof AuthError) {
        return json(err.kernelError.httpStatus, authErrorBody(err) as unknown as Json)
      }
      const ke = redactError({
        category: 'internal',
        code: 'SK_INTERNAL',
        message: 'internal error',
        details: null,
        hint: null,
        httpStatus: 500,
        retryable: true,
      })
      return json(ke.httpStatus, {
        code: '500',
        error_code: 'unexpected_failure',
        msg: ke.message,
      } satisfies AuthErrorBody as unknown as Json)
    }
  }
}

async function requireApiKey(service: AuthService, ctx: Ctx): Promise<void> {
  if (ctx.path === 'health' || ctx.path === 'settings' || ctx.path === '.well-known/jwks.json')
    return
  const apikey = ctx.headers.get('apikey') ?? ''
  const resolved = apikey
    ? await resolveApiKey(service.db, service.crypto, service.config, apikey)
    : null
  if (!resolved) {
    throw new AuthError(
      {
        category: 'authn',
        code: 'SK_AUTH_NO_API_KEY',
        message: 'No API key found in request',
        details: null,
        hint: null,
        httpStatus: 401,
        retryable: false,
      },
      'no_api_key',
    )
  }
}

async function dispatch(service: AuthService, ctx: Ctx): Promise<RouteResult> {
  const { method, path } = ctx
  const bearer = (ctx.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const apikey = ctx.headers.get('apikey') ?? ''
  const accessToken = bearer && bearer !== apikey ? bearer : ''

  if (path === 'health') return ok(await service.health())
  if (path === 'settings') return ok(service.settings())
  if (path === '.well-known/jwks.json') return ok(await service.jwks())

  if (path === 'signup' && method === 'POST') {
    const b = obj(ctx.body)
    const res = await service.signUp({
      email: str(b.email),
      password: str(b.password),
      data: (b.data as Record<string, Json>) ?? {},
      ipClass: ctx.ipClass,
    })
    return ok((res.session ?? res.user) as unknown as Json)
  }

  if (path === 'token' && method === 'POST') {
    const grant = ctx.query.get('grant_type')
    const b = obj(ctx.body)
    if (grant === 'password') {
      return ok(
        (await service.signInWithPassword({
          email: str(b.email),
          password: str(b.password),
          ipClass: ctx.ipClass,
        })) as unknown as Json,
      )
    }
    if (grant === 'refresh_token') {
      return ok((await service.refreshSession(str(b.refresh_token))) as unknown as Json)
    }
    throw service.unsupported(`grant_type "${grant}"`)
  }

  if (path === 'user' && method === 'GET')
    return ok((await service.getUser(accessToken)) as unknown as Json)
  if (path === 'user' && method === 'PUT') {
    const b = obj(ctx.body)
    const patch: { password?: string; email?: string; data?: Record<string, Json> } = {}
    if (b.password !== undefined) patch.password = str(b.password)
    if (b.email !== undefined) patch.email = str(b.email)
    if (b.data !== undefined) patch.data = b.data as Record<string, Json>
    return ok((await service.updateUser(accessToken, patch)) as unknown as Json)
  }

  if (path === 'logout' && method === 'POST') {
    const scope = ctx.query.get('scope') ?? 'global'
    await service.signOut(accessToken, scope === 'local' || scope === 'others' ? scope : 'global')
    return { status: 204, body: '' }
  }

  if (path === 'recover' && method === 'POST') {
    await service.recover({ email: str(obj(ctx.body).email), ipClass: ctx.ipClass })
    return ok({})
  }

  if (path === 'verify' && (method === 'POST' || method === 'GET')) {
    const src = method === 'POST' ? obj(ctx.body) : Object.fromEntries(ctx.query.entries())
    const vinput: { type: string; token: string; email?: string; ipClass?: string } = {
      type: str(src.type),
      token: str(src.token),
      ipClass: ctx.ipClass,
    }
    if (src.email) vinput.email = str(src.email)
    return ok((await service.verify(vinput)) as unknown as Json)
  }

  if (path.startsWith('admin/users')) return adminUsers(service, ctx)

  throw service.unsupported(`${method} /${path}`)
}

async function adminUsers(service: AuthService, ctx: Ctx): Promise<RouteResult> {
  const caller = await service.resolvePrincipal(ctx.headers)
  const id = ctx.path.split('/')[2]
  const b = obj(ctx.body)
  if (ctx.method === 'GET' && !id)
    return ok((await service.admin.listUsers(caller)) as unknown as Json)
  if (ctx.method === 'GET' && id)
    return ok((await service.admin.getUser(caller, id)) as unknown as Json)
  if (ctx.method === 'POST' && !id) {
    return ok(
      (await service.admin.createUser(caller, {
        email: str(b.email),
        password: b.password ? str(b.password) : undefined,
        email_confirm: b.email_confirm as boolean | undefined,
        user_metadata: b.user_metadata as Record<string, Json> | undefined,
        app_metadata: b.app_metadata as Record<string, Json> | undefined,
        role: b.role ? str(b.role) : undefined,
      })) as unknown as Json,
    )
  }
  if (ctx.method === 'PUT' && id) {
    return ok(
      (await service.admin.updateUser(caller, id, {
        password: b.password ? str(b.password) : undefined,
        email: b.email ? str(b.email) : undefined,
        role: b.role ? str(b.role) : undefined,
        ban_duration: b.ban_duration ? str(b.ban_duration) : undefined,
        user_metadata: b.user_metadata as Record<string, Json> | undefined,
        app_metadata: b.app_metadata as Record<string, Json> | undefined,
      })) as unknown as Json,
    )
  }
  if (ctx.method === 'DELETE' && id) {
    await service.admin.deleteUser(caller, id)
    return ok({})
  }
  throw service.unsupported(`${ctx.method} /${ctx.path}`)
}

function ok(body: Json): RouteResult {
  return { status: 200, body }
}
function obj(body: Json): Record<string, Json> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, Json>)
    : {}
}
function str(v: Json | undefined): string {
  return v === undefined || v === null ? '' : String(v)
}
async function readBody(request: Request): Promise<Json> {
  if (request.method === 'GET' || request.method === 'HEAD') return {}
  const text = await request.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text) as Json
  } catch {
    return {}
  }
}
function json(status: number, body: Json, headers: Record<string, string> = {}): Response {
  const empty = body === '' || body === undefined
  return new Response(empty ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}
