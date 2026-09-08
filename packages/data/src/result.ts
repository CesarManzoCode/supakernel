import type { Json } from '@supakernel/contracts'
import { cardinality, DataError } from './errors.js'
import type { ExecOutcome } from './execute.js'
import type { ParsedRequest } from './parse-url.js'
import type { DataQueryPlan } from './plan.js'

export interface DataHttpResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Json
}

/** Shape an execution outcome into the PostgREST-compatible HTTP response (contract §11.1). */
export function shapeResult(
  parsed: ParsedRequest,
  plan: DataQueryPlan,
  outcome: ExecOutcome,
): DataHttpResponse {
  const op = plan.op
  const headers: Record<string, string> = {}
  if (parsed.prefer.count === 'exact') headers['preference-applied'] = 'count=exact'

  if (op.kind === 'select') {
    const offset = op.page ? op.page.offset : 0
    const len = outcome.rows.length
    const totalPart = outcome.total !== null ? String(outcome.total) : '*'
    headers['content-range'] =
      len === 0 ? `*/${totalPart}` : `${offset}-${offset + len - 1}/${totalPart}`
    // PostgREST answers a bounded window (a `Range` header / `limit`/`offset`) that does not
    // span the whole set with 206 Partial Content; an unbounded select stays 200 (contract
    // §11.1, PostgREST `Response.hs`).
    let status = 200
    if (op.page && len > 0) {
      const end = offset + len - 1
      const partial =
        offset > 0 || (outcome.total !== null ? end < outcome.total - 1 : len >= op.page.limit)
      if (partial) status = 206
    }
    if (parsed.expectObject) return single(status, headers, outcome.rows)
    return { status, headers, body: outcome.rows as Json[] }
  }

  if (parsed.prefer.count === 'exact' && outcome.total !== null) {
    headers['content-range'] = `*/${outcome.total}`
  }

  const representation = parsed.returning === 'representation'
  const created = op.kind === 'insert'
  if (!representation) return { status: created ? 201 : 204, headers, body: '' }
  if (parsed.expectObject) return single(created ? 201 : 200, headers, outcome.rows)
  return { status: created ? 201 : 200, headers, body: outcome.rows as Json[] }
}

function single(
  status: number,
  headers: Record<string, string>,
  rows: ReadonlyArray<Record<string, Json>>,
): DataHttpResponse {
  if (rows.length === 1) return { status, headers, body: rows[0] as Json }
  throw new DataError(cardinality('exactly 1', rows.length))
}
