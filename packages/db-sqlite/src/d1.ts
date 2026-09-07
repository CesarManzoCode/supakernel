// @supakernel/db-sqlite/d1 — Cloudflare D1 entrypoint. Runs inside a Worker on real workerd.
// A minimal ambient declaration for the slice of the D1 binding we use, so no
// `@cloudflare/workers-types` dependency is pulled (contract §33.1 age gate).
declare global {
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement
    all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: D1Meta }>
    run<T = Record<string, unknown>>(): Promise<{ results?: T[]; success: boolean; meta: D1Meta }>
  }
  interface D1Meta {
    changes?: number
    rows_written?: number
    last_row_id?: number
  }
  interface D1Database {
    prepare(sql: string): D1PreparedStatement
    batch<T = Record<string, unknown>>(
      statements: D1PreparedStatement[],
    ): Promise<{ results: T[]; success: boolean; meta: D1Meta }[]>
    exec(sql: string): Promise<{ count: number; duration: number }>
  }
}

import type { RuntimeId } from '@supakernel/contracts'
import { SqliteAdapter } from './core.js'
import type { PhysicalRow, PhysicalValue, SqliteDriver } from './driver.js'

function normalizeValue(v: unknown): PhysicalValue {
  if (v === null || v === undefined) return null
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (v instanceof Uint8Array) return v
  if (Array.isArray(v) && v.every((n) => typeof n === 'number')) return new Uint8Array(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

function normalizeRow(row: Record<string, unknown>): PhysicalRow {
  const out: Record<string, PhysicalValue> = {}
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v)
  return out
}

function bindParam(v: PhysicalValue): unknown {
  // D1 must never receive a JS bigint; the core has already marshalled int64 to a decimal
  // string. Bytes go over as a plain number array (D1 stores them as BLOB).
  if (v instanceof Uint8Array) return [...v]
  return v
}

class D1Driver implements SqliteDriver {
  readonly kind = 'd1' as const
  readonly supportsInteractiveTransactions = false
  private readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  async exec(sql: string): Promise<void> {
    // D1.exec runs each `;`-terminated statement; strip newlines it dislikes.
    for (const stmt of splitStatements(sql)) {
      await this.db.prepare(stmt).run()
    }
  }

  async all(sql: string, params: readonly PhysicalValue[]): Promise<PhysicalRow[]> {
    try {
      const stmt = this.db.prepare(sql).bind(...params.map(bindParam))
      // A write with RETURNING must go through `.run()` — D1's `.all()` does not commit the
      // mutation, only reads back the projected rows (workerd quirk). `.run()` both commits
      // and returns `results` for the RETURNING clause.
      const res = MUTATION_RETURNING.test(sql) ? await stmt.run() : await stmt.all()
      return ((res.results ?? []) as Record<string, unknown>[]).map(normalizeRow)
    } catch (err) {
      throw withStatement(err, sql)
    }
  }

  async run(sql: string, params: readonly PhysicalValue[]): Promise<{ changes: number }> {
    try {
      const res = await this.db
        .prepare(sql)
        .bind(...params.map(bindParam))
        .run()
      return { changes: res.meta.changes ?? res.meta.rows_written ?? 0 }
    } catch (err) {
      throw withStatement(err, sql)
    }
  }

  async batch(
    statements: readonly { sql: string; params: readonly PhysicalValue[] }[],
  ): Promise<{ changes: number }[]> {
    const prepared = statements.map((s) => this.db.prepare(s.sql).bind(...s.params.map(bindParam)))
    const results = await this.db.batch(prepared)
    return results.map((r) => ({ changes: r.meta.changes ?? r.meta.rows_written ?? 0 }))
  }

  close(): Promise<void> {
    // The binding lifetime is owned by the Worker runtime.
    return Promise.resolve()
  }
}

const MUTATION_RETURNING = /^\s*(insert|update|delete)\b[\s\S]*\breturning\b/i

function withStatement(err: unknown, sql: string): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  // Internal context only; the codec redacts before anything reaches a client.
  ;(e as Error & { statement?: string }).statement = sql
  return e
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export interface OpenD1Options {
  readonly binding: D1Database
  readonly id?: string
  readonly runtime?: RuntimeId
}

export function openD1(options: OpenD1Options): SqliteAdapter {
  return new SqliteAdapter({
    id: options.id ?? 'sqlite-d1',
    runtime: options.runtime ?? 'workers',
    driver: new D1Driver(options.binding),
    transactionModel: 'atomic-batch',
  })
}
