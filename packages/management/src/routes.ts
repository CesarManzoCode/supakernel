import { type Json, redactError, type SchemaIR } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { applyMigration, listMigrations } from './migrations.js'
import { MANAGEMENT_OPENAPI } from './openapi.js'
import { executeManagementQuery, ManagementError } from './query.js'
import { generateTypescriptTypes } from './types.js'

export interface ManagementProject {
  readonly ref: string
  readonly name: string
  readonly region?: string
  readonly adapter: DatabaseAdapter
  schema(): SchemaIR | Promise<SchemaIR>
  apiKeys(): Array<{ name: string; type: string; prefix?: string }>
}

export interface ManagementDeps {
  projects(): ManagementProject[] | Promise<ManagementProject[]>
  /** Verify the caller holds a Management-audience token (contract §16 — separate keyspace). */
  authorize(headers: Headers): boolean | Promise<boolean>
  /** `database/query` is disabled by default (contract §16). */
  readonly queryEnabled: boolean
  /** When true, `database/query` requires a loopback peer. */
  readonly loopbackOnly: boolean
  /** Peer IP class of the request, supplied by the gateway. */
  peerIsLoopback(headers: Headers): boolean
  capabilities(): Json | Promise<Json>
  health(): Json | Promise<Json>
  readonly queryTimeoutMs: number
}

const BASE = /^\/?/

/** A `fetch`-shaped handler for the Management subset + `/_system` endpoints (contract §16). */
export function createManagementHandler(
  deps: ManagementDeps,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(BASE, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    try {
      if (path === '/_system/health') return json(200, await deps.health())
      if (path === '/_system/openapi') return json(200, MANAGEMENT_OPENAPI)
      if (path === '/.well-known/supakernel-capabilities')
        return json(200, await deps.capabilities())

      if (!path.startsWith('/v1/'))
        throw new ManagementError({
          category: 'not_found',
          code: 'SK_MGMT_UNKNOWN_ROUTE',
          message: `unknown route ${path}`,
          details: null,
          hint: null,
          httpStatus: 404,
          retryable: false,
        })

      if (!(await deps.authorize(request.headers))) {
        return json(401, { message: 'Unauthorized' })
      }
      return await v1(deps, request, url, path.split('/').filter(Boolean))
    } catch (err) {
      if (err instanceof ManagementError) {
        const ke = redactError(err.kernelError)
        return json(ke.httpStatus, { message: ke.message, code: ke.code })
      }
      return json(500, { message: 'internal error', code: 'SK_INTERNAL' })
    }
  }
}

async function v1(
  deps: ManagementDeps,
  request: Request,
  url: URL,
  seg: string[],
): Promise<Response> {
  // seg = ['v1', 'projects', ...]
  const [, kind, ref, sub, sub2] = seg
  if (kind !== 'projects') throw notFound(url.pathname)

  const projects = await deps.projects()
  if (!ref) return json(200, projects.map(projectView))

  const project = projects.find((p) => p.ref === ref)
  if (!project) throw notFound(`project ${ref}`)

  if (!sub && request.method === 'GET') return json(200, projectView(project))

  if (sub === 'api-keys' && request.method === 'GET') {
    return json(
      200,
      project.apiKeys().map((k) => ({ name: k.name, type: k.type, api_key: redactKey(k.prefix) })),
    )
  }

  if (sub === 'database' && sub2 === 'query' && request.method === 'POST') {
    if (!deps.queryEnabled) throw forbidden('SK_MGMT_QUERY_DISABLED', 'database/query is disabled')
    if (deps.loopbackOnly && !deps.peerIsLoopback(request.headers)) {
      throw forbidden('SK_MGMT_QUERY_LOOPBACK_ONLY', 'database/query is loopback-only')
    }
    const body = (await readJson(request)) as { query?: unknown; read_only?: unknown }
    const res = await executeManagementQuery(project.adapter, String(body.query ?? ''), {
      readOnly: body.read_only !== false,
      timeoutMs: deps.queryTimeoutMs,
    })
    return json(201, res.rows as Json[])
  }

  if (sub === 'database' && sub2 === 'migrations') {
    if (request.method === 'GET')
      return json(200, (await listMigrations(project.adapter)) as Json[])
    if (request.method === 'POST') {
      const body = (await readJson(request)) as { name?: unknown; query?: unknown }
      const applied = await applyMigration(project.adapter, {
        name: String(body.name ?? 'migration'),
        query: String(body.query ?? ''),
      })
      return json(201, applied as unknown as Json)
    }
  }

  if (sub === 'types' && sub2 === 'typescript' && request.method === 'GET') {
    return json(200, { types: generateTypescriptTypes(await project.schema()) })
  }

  throw notFound(url.pathname)
}

function projectView(p: ManagementProject): Json {
  return {
    id: p.ref,
    ref: p.ref,
    name: p.name,
    region: p.region ?? 'local',
    status: 'ACTIVE_HEALTHY',
    database: {
      host: 'localhost',
      version: p.adapter.capabilities.family === 'postgres' ? '18.6' : 'sqlite',
    },
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

function redactKey(prefix?: string): string {
  return `${prefix ?? 'sb_secret'}_${'*'.repeat(20)}`
}
function notFound(what: string): ManagementError {
  return new ManagementError({
    category: 'not_found',
    code: 'SK_MGMT_NOT_FOUND',
    message: `not found: ${what}`,
    details: null,
    hint: null,
    httpStatus: 404,
    retryable: false,
  })
}
function forbidden(code: string, message: string): ManagementError {
  return new ManagementError({
    category: 'authz',
    code,
    message,
    details: null,
    hint: null,
    httpStatus: 403,
    retryable: false,
  })
}
async function readJson(request: Request): Promise<unknown> {
  const t = await request.text().catch(() => '')
  if (!t) return {}
  try {
    return JSON.parse(t)
  } catch {
    return {}
  }
}
function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
