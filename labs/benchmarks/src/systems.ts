// SystemClient adapters (contract §23.1). Each maps the abstract workload onto its own REST
// surface and normalizes the response back to a `LogicalResult`. Adapter code is allowed —
// it is transport shaping, not the semantic core.

import type { WorkloadOp } from './manifest.js'
import type { LogicalResult, SystemClient } from './validator.js'

const cls = (status: number): string => (status < 300 ? '2xx' : status < 500 ? '4xx' : '5xx')

interface Row {
  id: number
  tenant_id: string
  body: string
  done: boolean | number
}

function normRow(r: Row | undefined): LogicalResult['row'] {
  if (!r) return null
  return { tenant_id: String(r.tenant_id), body: String(r.body), done: Boolean(r.done) }
}

/** SupaKernel (PostgREST subset at `/rest/v1`). */
export function supakernelClient(baseUrl: string, apikey: string): SystemClient {
  const h = { apikey, authorization: `Bearer ${apikey}`, 'content-type': 'application/json' }
  const j = async (
    res: Response,
  ): Promise<{ status: number; body: unknown; count: number | null }> => {
    const cr = res.headers.get('content-range')
    const count = cr?.includes('/') ? Number(cr.split('/')[1]) : null
    const text = await res.text()
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      count: Number.isFinite(count) ? count : null,
    }
  }
  return {
    id: 'supakernel',
    async run(op: WorkloadOp): Promise<LogicalResult> {
      const t = op.input
      if (op.kind === 'list') {
        const r = await j(
          await fetch(`${baseUrl}/rest/v1/todos?tenant_id=eq.${t.tenant_id}&select=id&order=id`, {
            headers: { ...h, prefer: 'count=exact' },
          }),
        )
        const rows = (r.body as { id: number }[]) ?? []
        return {
          statusClass: cls(r.status),
          rowIds: rows.map((x) => x.id),
          count: r.count,
          row: null,
        }
      }
      if (op.kind === 'get') {
        const r = await j(
          await fetch(`${baseUrl}/rest/v1/todos?id=eq.${t.id}&select=id,tenant_id,body,done`, {
            headers: h,
          }),
        )
        const row = ((r.body as Row[]) ?? [])[0]
        return {
          statusClass: cls(r.status),
          rowIds: row ? [row.id] : [],
          count: null,
          row: normRow(row),
        }
      }
      if (op.kind === 'page') {
        const r = await j(
          await fetch(`${baseUrl}/rest/v1/todos?tenant_id=eq.${t.tenant_id}&select=id&order=id`, {
            headers: {
              ...h,
              range: `${t.offset}-${(t.offset as number) + (t.limit as number) - 1}`,
              prefer: 'count=exact',
            },
          }),
        )
        const rows = (r.body as { id: number }[]) ?? []
        return {
          statusClass: cls(r.status),
          rowIds: rows.map((x) => x.id),
          count: r.count,
          row: null,
        }
      }
      if (op.kind === 'insert') {
        const r = await j(
          await fetch(`${baseUrl}/rest/v1/todos`, {
            method: 'POST',
            headers: { ...h, prefer: 'return=representation' },
            body: JSON.stringify({
              tenant_id: t.tenant_id,
              body: t.body,
              done: t.done,
              created_at: '2026-01-01T00:00:00Z',
            }),
          }),
        )
        const row = ((r.body as Row[]) ?? [])[0]
        return { statusClass: cls(r.status), rowIds: null, count: null, row: normRow(row) }
      }
      if (op.kind === 'update') {
        const r = await j(
          await fetch(`${baseUrl}/rest/v1/todos?id=eq.${t.id}`, {
            method: 'PATCH',
            headers: { ...h, prefer: 'return=representation' },
            body: JSON.stringify({ done: t.done }),
          }),
        )
        const row = ((r.body as Row[]) ?? [])[0]
        return { statusClass: cls(r.status), rowIds: null, count: null, row: normRow(row) }
      }
      const r = await fetch(`${baseUrl}/rest/v1/todos?id=eq.${t.id}`, {
        method: 'DELETE',
        headers: h,
      })
      return { statusClass: cls(r.status), rowIds: null, count: null, row: null }
    },
    async durability() {
      const r = await fetch(`${baseUrl}/_bench/durability`).then(
        (x) => x.json() as Promise<Record<string, unknown>>,
      )
      return {
        journalMode: String(r.journalMode),
        foreignKeys: Boolean(r.foreignKeys),
        synchronous: String(r.synchronous),
      }
    },
    async rowCount() {
      const r = await fetch(`${baseUrl}/rest/v1/todos?select=id`, {
        headers: { ...h, prefer: 'count=exact' },
      })
      const cr = r.headers.get('content-range')
      return cr?.includes('/') ? Number(cr.split('/')[1]) : 0
    },
  }
}

/** BKND (auto REST at `/api/data/entity/todos`). */
export function bkndClient(baseUrl: string): SystemClient {
  const h = { 'content-type': 'application/json' }
  const list = async (
    qs: string,
  ): Promise<{ status: number; rows: Row[]; count: number | null }> => {
    const res = await fetch(`${baseUrl}/api/data/entity/todos${qs}`, { headers: h })
    const body = (await res.json().catch(() => ({}))) as {
      data?: Row[]
      body?: Row[]
      meta?: { count?: number; total?: number }
    }
    const rows = body.data ?? body.body ?? (Array.isArray(body) ? (body as Row[]) : [])
    return { status: res.status, rows, count: body.meta?.count ?? body.meta?.total ?? null }
  }
  return {
    id: 'bknd',
    async run(op: WorkloadOp): Promise<LogicalResult> {
      const t = op.input
      if (op.kind === 'list') {
        const r = await list(
          `?where=${encodeURIComponent(JSON.stringify({ tenant_id: t.tenant_id }))}&sort=id&limit=100000`,
        )
        return {
          statusClass: cls(r.status),
          rowIds: r.rows.map((x) => x.id),
          count: r.count,
          row: null,
        }
      }
      if (op.kind === 'get') {
        const res = await fetch(`${baseUrl}/api/data/entity/todos/${t.id}`, { headers: h })
        const body = (await res.json().catch(() => ({}))) as { data?: Row }
        const row = body.data
        return {
          statusClass: cls(res.status),
          rowIds: row ? [row.id] : [],
          count: null,
          row: normRow(row),
        }
      }
      if (op.kind === 'page') {
        const r = await list(
          `?where=${encodeURIComponent(JSON.stringify({ tenant_id: t.tenant_id }))}&sort=id&offset=${t.offset}&limit=${t.limit}`,
        )
        return {
          statusClass: cls(r.status),
          rowIds: r.rows.map((x) => x.id),
          count: r.count,
          row: null,
        }
      }
      if (op.kind === 'insert') {
        const res = await fetch(`${baseUrl}/api/data/entity/todos`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({
            tenant_id: t.tenant_id,
            body: t.body,
            done: t.done,
            created_at: '2026-01-01T00:00:00Z',
          }),
        })
        const body = (await res.json().catch(() => ({}))) as { data?: Row }
        return { statusClass: cls(res.status), rowIds: null, count: null, row: normRow(body.data) }
      }
      if (op.kind === 'update') {
        const res = await fetch(`${baseUrl}/api/data/entity/todos/${t.id}`, {
          method: 'PATCH',
          headers: h,
          body: JSON.stringify({ done: t.done }),
        })
        const body = (await res.json().catch(() => ({}))) as { data?: Row }
        return { statusClass: cls(res.status), rowIds: null, count: null, row: normRow(body.data) }
      }
      const res = await fetch(`${baseUrl}/api/data/entity/todos/${t.id}`, {
        method: 'DELETE',
        headers: h,
      })
      return { statusClass: cls(res.status), rowIds: null, count: null, row: null }
    },
    async durability() {
      const r = (await fetch(`${baseUrl}/_bench/durability`).then((x) =>
        x.json().catch(() => ({})),
      )) as Record<string, unknown>
      return {
        journalMode: String(r.journalMode ?? 'unknown'),
        foreignKeys: Boolean(r.foreignKeys),
        synchronous: String(r.synchronous ?? 'unknown'),
      }
    },
    async rowCount() {
      const r = await list('?limit=1&offset=0')
      return r.count ?? 0
    },
  }
}
