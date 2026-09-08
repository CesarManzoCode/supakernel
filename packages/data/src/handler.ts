import type { Family, Json, PolicyRule, Principal, SchemaIR } from '@supakernel/contracts'
import type { DatabaseAdapter, FaultPort } from '@supakernel/ports'
import { NULL_FAULT_PORT } from '@supakernel/ports'
import { toKernelError, toPostgrestBody } from './error-map.js'
import { executeData } from './execute.js'
import { generateOpenApi } from './openapi.js'
import { parseRequest, type RawRequest } from './parse-url.js'
import { type DataContext, planData } from './plan.js'
import { shapeResult } from './result.js'

export interface DataHandlerDeps {
  readonly adapter: DatabaseAdapter
  readonly schema: SchemaIR
  readonly policies: readonly PolicyRule[]
  readonly family: Family
  /** RFC3339 UTC from the Clock port. */
  now(): string
  /** Resolve the verified principal from request headers (Auth is L6; a stub is injected in L5). */
  resolvePrincipal(headers: Headers): Principal | Promise<Principal>
  /** Fault-injection hook (contract §22). No-op in production. */
  readonly fault?: FaultPort
}

/**
 * A `fetch`-shaped Data handler (contract §11, §30 L5). The fixture app points
 * `@supabase/supabase-js` at this via a custom `fetch`; nothing here imports Hono or an
 * adapter package — only the canonical protocol and domain layers.
 */
export function createDataHandler(deps: DataHandlerDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/?(rest\/v1\/?)?/, '')

    if ((path === '' || path === '/') && request.method === 'GET') {
      const { document, etag } = generateOpenApi(deps.schema)
      return json(200, document, { etag })
    }

    try {
      const principal = await deps.resolvePrincipal(request.headers)
      const body = await readBody(request)
      const raw: RawRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      }
      const parsed = parseRequest(raw, deps.schema)
      const ctx: DataContext = {
        schema: deps.schema,
        policies: deps.policies,
        family: deps.family,
        principal,
        now: deps.now(),
      }
      const plan = planData(ctx, parsed)
      const outcome = await executeData(
        ctx,
        deps.adapter,
        parsed,
        plan,
        deps.fault ?? NULL_FAULT_PORT,
      )
      // The write has committed here; a fault must never duplicate on retry (contract §22).
      await (deps.fault ?? NULL_FAULT_PORT).hit('transaction.after_commit_before_response', {})
      const shaped = shapeResult(parsed, plan, outcome)
      return json(shaped.status, shaped.body, shaped.headers)
    } catch (err) {
      const ke = toKernelError(err)
      return json(ke.httpStatus, toPostgrestBody(ke) as unknown as Json)
    }
  }
}

async function readBody(request: Request): Promise<Json | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE')
    return undefined
  const text = await request.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

function json(status: number, body: Json, headers: Record<string, string> = {}): Response {
  const isEmpty = body === '' || body === undefined
  return new Response(isEmpty ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  })
}
