import type { Json, Order, QueryOperation, SchemaIR, Selection, Table } from '@supakernel/contracts'
import { findColumn, findTable } from '@supakernel/contracts'
import {
  dataError,
  dataUnsupported,
  filterRequired,
  malformedFilter,
  unknownRelation,
} from './errors.js'
import { parseFilters } from './parse-filter.js'
import { type Preferences, parsePrefer } from './parse-prefer.js'
import { parseSelect } from './parse-select.js'

export interface RawRequest {
  readonly method: string
  /** Full URL or path; the base `/rest/v1` prefix is stripped. */
  readonly url: string
  readonly headers: { get(name: string): string | null }
  readonly body?: Json
}

export interface ParsedRequest {
  readonly operation: QueryOperation
  readonly prefer: Preferences
  readonly range: { readonly from: number; readonly to: number } | null
  readonly returning: 'representation' | 'minimal'
  /** `Accept: application/vnd.pgrst.object+json` — the client wants a single object. */
  readonly expectObject: boolean
}

const BASE = /^\/?(rest\/v1\/)?/

export function parseRequest(raw: RawRequest, schema: SchemaIR): ParsedRequest {
  const url = new URL(raw.url, 'http://sk.local')
  const pathname = url.pathname.replace(BASE, '')
  if (pathname === '' || pathname === '/')
    throw dataError(dataUnsupported('root introspection is handled by GET /rest/v1/'))
  const [tableName, ...restPath] = pathname.split('/')
  if (restPath.length > 0 && restPath.some(Boolean)) {
    throw dataError(dataUnsupported('path segments after the table (rpc / nested resources)'))
  }
  for (const profile of [
    url.searchParams.get('schema'),
    raw.headers.get('accept-profile'),
    raw.headers.get('content-profile'),
  ]) {
    if (profile !== null && profile !== '' && profile !== 'public') {
      throw dataError(dataUnsupported('schema switching (only "public" is served)'))
    }
  }

  const table = findTable(schema, tableName ?? '')
  if (!table) throw dataError(unknownRelation('table', tableName ?? ''))

  const prefer = parsePrefer(raw.headers.get('prefer'))
  if (prefer.unsupported.length > 0) {
    throw dataError(dataUnsupported(`Prefer token(s): ${prefer.unsupported.join(', ')}`))
  }

  const accept = raw.headers.get('accept') ?? ''
  if (accept.includes('text/csv')) throw dataError(dataUnsupported('CSV output'))
  const wantsObject = accept.includes('application/vnd.pgrst.object+json')

  const params = url.searchParams
  const select = parseSelect(params.get('select'))
  const method = raw.method.toUpperCase()

  const range = parseRange(raw.headers.get('range'))
  const returning: 'representation' | 'minimal' =
    method === 'GET' || method === 'HEAD' || prefer.return === 'representation'
      ? 'representation'
      : 'minimal'

  const column = (name: string): ReturnType<typeof findColumn> => findColumn(table, name)

  if (method === 'GET' || method === 'HEAD') {
    const where = parseFilters(params, table.name, column)
    return {
      operation: {
        kind: 'select',
        table: table.name,
        fields: select,
        where,
        order: parseOrder(params.get('order'), table),
        page: parsePage(params, range),
        cardinality: wantsObject ? 'one' : 'many',
        count: prefer.count === 'exact' ? 'exact' : 'none',
      },
      prefer,
      range,
      returning: method === 'HEAD' ? 'minimal' : 'representation',
      expectObject: wantsObject,
    }
  }

  if (method === 'POST') {
    const rows = asRows(raw.body)
    // postgrest-js sends `?columns="a","b"` — names are double-quoted to allow special chars.
    const columns = params
      .get('columns')
      ?.split(',')
      .map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean)
    const normalized = normalizeRows(rows, columns)
    return {
      operation: {
        kind: 'insert',
        table: table.name,
        rows: normalized,
        onConflict:
          params
            .get('on_conflict')
            ?.split(',')
            .map((c) => c.trim())
            .filter(Boolean) ?? [],
        resolution: prefer.resolution,
        missing: prefer.missing,
        returning: returning === 'representation' ? select : 'minimal',
      },
      prefer,
      range,
      returning,
      expectObject: wantsObject,
    }
  }

  if (method === 'PATCH') {
    const where = parseFilters(params, table.name, column)
    if (where === null) throw dataError(filterRequired('PATCH'))
    return {
      operation: {
        kind: 'update',
        table: table.name,
        patch: asObject(raw.body),
        where,
        returning: returning === 'representation' ? select : 'minimal',
      },
      prefer,
      range,
      returning,
      expectObject: wantsObject,
    }
  }

  if (method === 'DELETE') {
    const where = parseFilters(params, table.name, column)
    if (where === null) throw dataError(filterRequired('DELETE'))
    return {
      operation: {
        kind: 'delete',
        table: table.name,
        where,
        returning: returning === 'representation' ? select : 'minimal',
      },
      prefer,
      range,
      returning,
      expectObject: wantsObject,
    }
  }

  throw dataError(dataUnsupported(`HTTP method ${method}`))
}

function parseOrder(raw: string | null, table: Table): readonly Order[] {
  if (!raw) return []
  return raw.split(',').map((part) => {
    const [col, ...mods] = part.trim().split('.')
    if (!col || !findColumn(table, col))
      throw dataError(malformedFilter(`order by unknown column "${col}"`))
    const direction = mods.includes('desc') ? 'desc' : 'asc'
    const nulls = mods.includes('nullsfirst')
      ? 'first'
      : mods.includes('nullslast')
        ? 'last'
        : direction === 'asc'
          ? 'last'
          : 'first'
    return { column: col, direction, nulls }
  })
}

function parseRange(raw: string | null): { from: number; to: number } | null {
  if (!raw) return null
  const m = /^(\d+)-(\d*)$/.exec(raw.trim())
  if (!m) return null
  const from = Number(m[1])
  const to = m[2] === '' ? Number.MAX_SAFE_INTEGER : Number(m[2])
  return { from, to }
}

function parsePage(
  params: URLSearchParams,
  range: { from: number; to: number } | null,
): { limit: number; offset: number } | null {
  const limitParam = params.get('limit')
  const offsetParam = params.get('offset')
  if (limitParam !== null || offsetParam !== null) {
    const limit = limitParam !== null ? Number(limitParam) : Number.MAX_SAFE_INTEGER
    const offset = offsetParam !== null ? Number(offsetParam) : 0
    if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 0 || offset < 0) {
      throw dataError(malformedFilter('invalid limit / offset'))
    }
    return { limit, offset }
  }
  if (range) return { limit: range.to - range.from + 1, offset: range.from }
  return null
}

function asRows(body: Json | undefined): Json[] {
  if (Array.isArray(body)) return body
  if (body !== undefined && body !== null && typeof body === 'object') return [body]
  throw dataError(malformedFilter('insert body must be an object or an array of objects'))
}

function asObject(body: Json | undefined): Record<string, Json> {
  if (body !== null && body !== undefined && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, Json>
  }
  throw dataError(malformedFilter('update body must be a JSON object'))
}

function normalizeRows(
  rows: Json[],
  columns: readonly string[] | undefined,
): readonly Readonly<Record<string, Json>>[] {
  if (rows.length === 0) throw dataError(malformedFilter('empty insert body'))
  const objects = rows.map((r) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw dataError(malformedFilter('every insert row must be a JSON object'))
    }
    return r as Record<string, Json>
  })

  if (columns && columns.length > 0) {
    // `?columns=` fixes the column set; extra keys are ignored, missing keys default.
    return objects.map((o) => {
      const out: Record<string, Json> = {}
      for (const k of columns) if (k in o) out[k] = o[k] as Json
      return out
    })
  }

  // Bulk insert requires a uniform key set across every row (contract §11.3).
  const first = [...Object.keys(objects[0] as Record<string, Json>)].sort()
  for (const o of objects) {
    const keys = [...Object.keys(o)].sort()
    if (keys.length !== first.length || keys.some((k, i) => k !== first[i])) {
      throw dataError(
        malformedFilter(
          'all rows in a bulk insert must have the same keys; use ?columns= to fix them',
        ),
      )
    }
  }
  return objects
}

export type { Selection }
