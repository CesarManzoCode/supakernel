/**
 * First-party D1 conformance worker (contract §30 L2: "harness first-party … real workerd,
 * real local D1"). It exposes the SqliteAdapter running against `env.DB` over a tiny JSON RPC
 * so the shared connection contract suite can drive it from the test process.
 *
 * Wrangler bundles this file; it runs inside real workerd.
 */

import type { SqlValue } from '@supakernel/contracts'
import { openD1 } from '../../src/d1.ts'

interface Env {
  DB: D1Database
}

type WireValue =
  | { readonly $: 'bytes'; readonly b: number[] }
  | { readonly $: 'bigint'; readonly v: string }
  | null
  | boolean
  | number
  | string

function decode(v: WireValue): SqlValue {
  if (v !== null && typeof v === 'object') {
    if (v.$ === 'bytes') return new Uint8Array(v.b)
    if (v.$ === 'bigint') return BigInt(v.v)
  }
  return v as SqlValue
}

function encode(v: unknown): WireValue {
  if (v instanceof Uint8Array) return { $: 'bytes', b: [...v] }
  if (typeof v === 'bigint') return { $: 'bigint', v: v.toString() }
  return v as WireValue
}

function encodeRows(rows: readonly Record<string, unknown>[]): Record<string, WireValue>[] {
  return rows.map((r) => {
    const out: Record<string, WireValue> = {}
    for (const [k, val] of Object.entries(r)) out[k] = encode(val)
    return out
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 })
    const adapter = openD1({ binding: env.DB })
    const url = new URL(request.url)
    const body = (await request.json()) as {
      statements?: { text: string; parameters: WireValue[] }[]
      text?: string
      parameters?: WireValue[]
    }

    try {
      switch (url.pathname) {
        case '/execute': {
          const res = await adapter.execute({
            text: body.text ?? '',
            parameters: (body.parameters ?? []).map(decode),
          })
          return json({ rows: encodeRows(res.rows), rowCount: res.rowCount })
        }
        case '/batch': {
          const results = await adapter.atomicBatch(
            (body.statements ?? []).map((s) => ({
              text: s.text,
              parameters: s.parameters.map(decode),
            })),
          )
          return json({ results: results.map((r) => ({ rowCount: r.rowCount })) })
        }
        case '/introspect': {
          const observed = await adapter.introspect()
          return json(observed)
        }
        case '/reset': {
          const tables = await adapter.execute({
            text: `SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
            parameters: [],
          })
          for (const t of tables.rows) {
            const kind = String(t.type)
            if (kind === 'trigger')
              await adapter.execute({
                text: `DROP TRIGGER IF EXISTS "${String(t.name)}"`,
                parameters: [],
              })
          }
          for (const t of tables.rows) {
            if (String(t.type) === 'table') {
              await adapter.execute({
                text: `DROP TABLE IF EXISTS "${String(t.name)}"`,
                parameters: [],
              })
            }
          }
          return json({ ok: true })
        }
        default:
          return new Response('unknown op', { status: 404 })
      }
    } catch (err) {
      const ke = (err as { kernelError?: unknown }).kernelError
      const stmt = (err as { statement?: string }).statement
      return json(
        {
          error: true,
          message: (err as Error).message,
          kernelError: ke ?? null,
          statement: stmt ?? null,
        },
        500,
      )
    }
  },
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
