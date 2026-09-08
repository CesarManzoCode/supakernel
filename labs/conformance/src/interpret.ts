// Shared operation interpreter (contract §19.2): one mapping from the declarative operation
// vocabulary onto the fixed public client surface. The runner calls this for every target —
// there is no per-target branch anywhere in this file.
//
// `PublicClient` is the structural subset of `@supabase/supabase-js` the interpreter uses.
// The concrete supabase-js client is created in the (non-tsc) test support layer and passed
// in here, so this typechecked module never imports the client library (whose shipped
// `.d.ts` does not satisfy `exactOptionalPropertyTypes`).

import type { Json, JsonObject, ScenarioStep } from '@supakernel/contracts'
import { isJsonObject } from '@supakernel/contracts'
import { pickHeaders, type StepResult, stepInput } from './schema.js'

// biome-ignore lint/suspicious/noExplicitAny: the supabase-js builder chain is not generically typeable
type Builder = any

export interface PostgrestLike {
  from(table: string): Builder
}
export interface AuthLike {
  signUp(c: { email: string; password: string }): Promise<{ data: unknown; error: unknown }>
  signInWithPassword(c: {
    email: string
    password: string
  }): Promise<{ data: unknown; error: unknown }>
  getUser(token?: string): Promise<{ data: unknown; error: unknown }>
  updateUser(a: unknown): Promise<{ data: unknown; error: unknown }>
  refreshSession(c?: { refresh_token: string }): Promise<{ data: unknown; error: unknown }>
  signOut(o?: { scope: 'global' | 'local' | 'others' }): Promise<{ error: unknown }>
}
export interface StorageBucketLike {
  upload(path: string, body: unknown, opts?: unknown): Promise<{ data: unknown; error: unknown }>
  download(path: string): Promise<{ data: unknown; error: unknown }>
  list(prefix?: string): Promise<{ data: unknown; error: unknown }>
  remove(paths: string[]): Promise<{ data: unknown; error: unknown }>
  move(from: string, to: string): Promise<{ data: unknown; error: unknown }>
  copy(from: string, to: string): Promise<{ data: unknown; error: unknown }>
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: unknown }>
}
export interface StorageLike {
  from(bucket: string): StorageBucketLike
}
export interface PublicClient {
  from(table: string): Builder
  readonly auth: AuthLike
  readonly storage: StorageLike
  // biome-ignore lint/suspicious/noExplicitAny: realtime channel handle
  channel(name: string): any
}

/** Everything a target must expose so the shared interpreter can talk to it. */
export interface TargetClient {
  client(seatKey: string): PublicClient
  fetch(path: string, init?: RequestInit): Promise<Response>
  readonly baseUrl: string
  managementToken(): string
}

interface RawResult {
  status: number
  headers: Record<string, string>
  body: Json
  error?: string
  unsupported?: { code: string; reason: string }
}

const REFUSAL_CODE_RE = /^SK_[A-Z0-9_]+$/

function toJson(value: unknown): Json {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json)
}

function readError(error: unknown): { message: string; code?: string; status?: number } | null {
  if (!error) return null
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>
    const message = typeof e.message === 'string' ? e.message : JSON.stringify(e)
    const out: { message: string; code?: string; status?: number } = { message }
    if (typeof e.code === 'string') out.code = e.code
    if (typeof e.status === 'number') out.status = e.status
    return out
  }
  return { message: String(error) }
}

function applyFilters(query: Builder, filters: Json): Builder {
  if (!Array.isArray(filters)) return query
  let q = query
  for (const f of filters) {
    if (!Array.isArray(f) || f.length < 3) continue
    const [col, op, value] = f as [string, string, Json]
    q = q[op](col, value)
  }
  return q
}

async function runData(client: PublicClient, step: ScenarioStep): Promise<RawResult> {
  const input = stepInput(step)
  const table = String(input.table ?? '')
  let q: Builder = client.from(table)
  const action = step.action
  if (action === 'data.select') {
    q = q.select(
      String(input.columns ?? '*'),
      input.count ? { count: input.count as 'exact' } : undefined,
    )
    q = applyFilters(q, (input.filters ?? []) as Json)
    const order = input.order ?? null
    if (isJsonObject(order)) {
      q = q.order(String(order.column), { ascending: order.ascending !== false })
    }
    if (Array.isArray(input.range) && input.range.length === 2) {
      q = q.range(Number(input.range[0]), Number(input.range[1]))
    }
    if (input.single) q = q.single()
    else if (input.maybeSingle) q = q.maybeSingle()
  } else if (action === 'data.insert') {
    q = q.insert(input.values as Json)
    if (input.select) q = q.select(String(input.select))
  } else if (action === 'data.update') {
    q = q.update(input.values as Json)
    q = applyFilters(q, (input.filters ?? []) as Json)
    if (input.select) q = q.select(String(input.select))
  } else if (action === 'data.delete') {
    q = q.delete()
    q = applyFilters(q, (input.filters ?? []) as Json)
    if (input.select) q = q.select(String(input.select))
  } else if (action === 'data.upsert') {
    q = q.upsert(
      input.values as Json,
      input.onConflict ? { onConflict: String(input.onConflict) } : undefined,
    )
    if (input.select) q = q.select(String(input.select))
  }
  const res = await q
  const err = readError(res.error)
  const out: RawResult = {
    status: res.status ?? (err ? 400 : 200),
    headers: {},
    body: toJson({ data: res.data ?? null, count: res.count ?? null, error: err }),
  }
  if (err) {
    out.error = err.message
    if (err.code && REFUSAL_CODE_RE.test(err.code)) {
      out.unsupported = { code: err.code, reason: err.message }
    }
  }
  return out
}

async function runAuth(
  client: PublicClient,
  step: ScenarioStep,
  state: AuthState,
): Promise<RawResult> {
  const input = stepInput(step)
  const auth = client.auth
  let res: { data?: unknown; error: unknown }
  switch (step.action) {
    case 'auth.signUp':
      res = await auth.signUp({ email: String(input.email), password: String(input.password) })
      break
    case 'auth.signInWithPassword': {
      const r = await auth.signInWithPassword({
        email: String(input.email),
        password: String(input.password),
      })
      const session = (r.data as { session?: { refresh_token?: string } } | null)?.session
      if (!r.error && session?.refresh_token) state.refreshToken = session.refresh_token
      res = r
      break
    }
    case 'auth.getUser':
      res = await auth.getUser(state.accessTokenOverride)
      break
    case 'auth.updateUser':
      res = await auth.updateUser((input.attributes ?? {}) as Json)
      break
    case 'auth.refreshSession': {
      const r = state.refreshToken
        ? await auth.refreshSession({ refresh_token: state.refreshToken })
        : await auth.refreshSession()
      const session = (r.data as { session?: { refresh_token?: string } } | null)?.session
      if (!r.error && session?.refresh_token) state.refreshToken = session.refresh_token
      res = r
      break
    }
    case 'auth.signOut': {
      const r = await auth.signOut(input.scope ? { scope: input.scope as 'global' } : undefined)
      res = { data: r.error ? null : { ok: true }, error: r.error }
      break
    }
    default:
      res = { data: null, error: { message: `unknown auth action ${step.action}` } }
  }
  const err = readError(res.error)
  const out: RawResult = {
    status: err ? (err.status ?? 400) : 200,
    headers: {},
    body: toJson({ data: res.data ?? null, error: err }),
  }
  if (err) out.error = err.message
  return out
}

async function runStorage(
  client: PublicClient,
  step: ScenarioStep,
  target: TargetClient,
  state: StorageState,
): Promise<RawResult> {
  const input = stepInput(step)
  const bucket = String(input.bucket ?? '')
  const api = client.storage.from(bucket)
  const path = String(input.path ?? '')
  let res: { data?: unknown; error: unknown }
  switch (step.action) {
    case 'storage.upload':
      res = await api.upload(path, new Blob([String(input.content ?? 'conformance-bytes')]), {
        upsert: input.upsert === true,
        contentType: 'text/plain',
      })
      break
    case 'storage.download': {
      const r = await api.download(path)
      res = r.error
        ? { data: null, error: r.error }
        : { data: { text: await (r.data as Blob).text() }, error: null }
      break
    }
    case 'storage.list':
      res = await api.list(input.prefix ? String(input.prefix) : undefined)
      break
    case 'storage.remove':
      res = await api.remove((input.paths ?? [path]) as string[])
      break
    case 'storage.move':
      res = await api.move(path, String(input.destination))
      break
    case 'storage.copy':
      res = await api.copy(path, String(input.destination))
      break
    case 'storage.createSignedUrl': {
      const r = await api.createSignedUrl(path, Number(input.expiresIn ?? 60))
      if (!r.error && r.data) state.signedUrl = r.data.signedUrl
      res = r
      break
    }
    case 'storage.signedUrlGet': {
      const url = state.signedUrl ?? ''
      const relative = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
      const resp = await target.fetch(relative)
      res = {
        data: { status: resp.status, text: resp.ok ? await resp.text() : null },
        error: resp.ok ? null : { message: `HTTP ${resp.status}`, status: resp.status },
      }
      break
    }
    default:
      res = { data: null, error: { message: `unknown storage action ${step.action}` } }
  }
  const err = readError(res.error)
  const out: RawResult = {
    status: err ? (err.status ?? 400) : 200,
    headers: {},
    body: toJson({ data: res.data ?? null, error: err }),
  }
  if (err) out.error = err.message
  return out
}

async function runManagement(step: ScenarioStep, target: TargetClient): Promise<RawResult> {
  const input = stepInput(step)
  const token = target.managementToken()
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  let resp: Response
  switch (step.action) {
    case 'management.listProjects':
      resp = await target.fetch('/v1/projects', { headers })
      break
    case 'management.getApiKeys':
      resp = await target.fetch(`/v1/projects/${String(input.ref ?? 'local')}/api-keys`, {
        headers,
      })
      break
    case 'management.runQuery':
      resp = await target.fetch(`/v1/projects/${String(input.ref ?? 'local')}/database/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: String(input.query ?? 'select 1') }),
      })
      break
    case 'management.capabilities':
      resp = await target.fetch('/.well-known/supakernel-capabilities')
      break
    default:
      resp = new Response('null', { status: 500 })
  }
  const text = await resp.text()
  let body: Json
  try {
    body = JSON.parse(text) as Json
  } catch {
    body = text
  }
  const out: RawResult = { status: resp.status, headers: pickHeaders(resp.headers), body }
  if (!resp.ok) out.error = `HTTP ${resp.status}`
  return out
}

export interface AuthState {
  refreshToken?: string
  accessTokenOverride?: string
}
export interface StorageState {
  signedUrl?: string
}
export interface RealtimeState {
  events: Json[]
  // biome-ignore lint/suspicious/noExplicitAny: channel handle
  channel?: any
}

export interface InterpretSession {
  auth: AuthState
  storage: StorageState
  realtime: RealtimeState
}

export function newSession(): InterpretSession {
  return { auth: {}, storage: {}, realtime: { events: [] } }
}

export async function interpretStep(
  target: TargetClient,
  step: ScenarioStep,
  seatKey: string,
  session: InterpretSession,
): Promise<StepResult> {
  const client = target.client(seatKey)
  const request: JsonObject = { action: step.action, seat: seatKey, input: step.input }
  let raw: RawResult
  try {
    if (step.action.startsWith('data.')) raw = await runData(client, step)
    else if (step.action.startsWith('auth.')) raw = await runAuth(client, step, session.auth)
    else if (step.action.startsWith('storage.'))
      raw = await runStorage(client, step, target, session.storage)
    else if (step.action.startsWith('management.')) raw = await runManagement(step, target)
    else throw new Error(`interpreter cannot handle ${step.action}`)
  } catch (err) {
    raw = {
      status: 0,
      headers: {},
      body: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const result: StepResult = {
    step: step.id,
    action: step.action,
    request,
    status: raw.status,
    headers: raw.headers,
    body: raw.body,
  }
  if (raw.unsupported) return { ...result, unsupported: raw.unsupported }
  if (raw.error) return { ...result, error: raw.error }
  return result
}
