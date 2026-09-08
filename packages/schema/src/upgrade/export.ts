// Phase inputs: fingerprint the source and export a canonical bundle (contract §17.2 —
// "row count y multiset hash por tabla, con canonical JSON/type encoding"). Port-only.

import type { Json, PortableType, SchemaIR, Table } from '@supakernel/contracts'
import { canonicalJson, findColumn, sha256Hex, sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import type { AuthUserRecord, Fingerprint, StorageObjectRecord, UpgradeBundle } from './types.js'

const q = (name: string): string => `"${name.replace(/"/g, '""')}"`

async function all(
  adapter: DatabaseAdapter,
  text: string,
  params: readonly Json[] = [],
): Promise<Record<string, unknown>[]> {
  const r = await adapter.execute(sql(text, params as never[]))
  return (r.rows ?? []) as Record<string, unknown>[]
}

const TS_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/

/** Canonical value encoding, driver-independent: bigint/decimal -> string, timestamps
 *  (Date *or* a driver's timestamp string) -> a single ISO form, bytes -> base64, else JSON. */
export function canonicalRow(row: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = null
    else if (typeof v === 'bigint') out[k] = v.toString(10)
    else if (v instanceof Date) out[k] = v.toISOString()
    else if (v instanceof Uint8Array) out[k] = Buffer.from(v).toString('base64')
    else if (typeof v === 'string' && TS_LIKE.test(v) && !Number.isNaN(Date.parse(v))) {
      out[k] = new Date(v).toISOString()
    } else if (typeof v === 'object') out[k] = v as Json
    else out[k] = v as Json
  }
  return out
}

/** Column-type-aware canonicalization: driver quirks (PGlite bigint->number vs postgres.js
 *  bigint->string, 0/1 vs boolean) are erased so the multiset hash is driver-independent. */
export function canonicalRowTyped(
  row: Record<string, unknown>,
  table: Table,
): Record<string, Json> {
  const base = canonicalRow(row)
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(base)) {
    const type: PortableType | undefined = findColumn(table, k)?.type
    if (v === null) out[k] = null
    else if (
      (type === 'int64' || type === 'int32' || type === 'decimal') &&
      typeof v === 'number'
    ) {
      out[k] = String(v)
    } else if (type === 'bool' && typeof v !== 'boolean') {
      out[k] = v === 1 || v === '1' || v === 'true' || v === 't'
    } else {
      out[k] = v
    }
  }
  return out
}

/** Deterministic multiset hash: sha256 over the sorted list of per-row canonical hashes. */
export function multisetHash(rows: readonly Record<string, Json>[]): string {
  const per = rows.map((r) => sha256Hex(canonicalJson(r))).sort()
  return sha256Hex(canonicalJson(per as unknown as Json))
}

/** FK-topological order of the schema's tables (Kahn); a cycle falls back to name order. */
export function topoOrder(schema: SchemaIR): string[] {
  const names = schema.tables.map((t) => t.name)
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set()]))
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      if (fk.referencesTable !== t.name && deps.has(t.name)) {
        deps.get(t.name)?.add(fk.referencesTable)
      }
    }
  }
  const out: string[] = []
  const ready = names.filter((n) => (deps.get(n)?.size ?? 0) === 0).sort()
  const seen = new Set<string>()
  while (ready.length > 0) {
    const n = ready.shift() as string
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
    for (const m of names) {
      const d = deps.get(m)
      if (d?.has(n)) {
        d.delete(n)
        if (d.size === 0 && !seen.has(m)) ready.push(m)
      }
    }
    ready.sort()
  }
  for (const n of names) if (!seen.has(n)) out.push(n)
  return out
}

async function readSequences(
  adapter: DatabaseAdapter,
  schema: SchemaIR,
): Promise<UpgradeBundle['sequences']> {
  const out: Record<string, { last: string; increment: string; min: string; max: string }> = {}
  for (const seqDef of schema.sequences) {
    const owned = seqDef.ownedBy?.split('.') as [string, string] | undefined
    let last = seqDef.start
    if (adapter.capabilities.family === 'postgres') {
      // Real PG sequence state — never inferred from a default string.
      const rows = await all(adapter, `SELECT last_value, is_called FROM ${q(seqDef.name)}`).catch(
        () => [] as Record<string, unknown>[],
      )
      if (rows[0]) {
        const lv = String(rows[0].last_value)
        last = rows[0].is_called ? lv : String(BigInt(lv) - 1n)
      }
    } else if (owned) {
      // SQLite: the authoritative value is the live MAX(id), not the identity default text
      // (contract §17.2 — "sequence inferred only from SQLite default text" is a refusal).
      const [table, column] = owned
      const rows = await all(
        adapter,
        `SELECT MAX(CAST(${q(column)} AS INTEGER)) AS m FROM ${q(table)}`,
      )
      last = rows[0]?.m != null ? String(rows[0].m) : String(BigInt(seqDef.start) - 1n)
    }
    out[seqDef.name] = {
      last,
      increment: seqDef.increment,
      min: seqDef.min,
      max: seqDef.max,
    }
  }
  return out
}

async function readAuthUsers(adapter: DatabaseAdapter): Promise<AuthUserRecord[]> {
  const isPg = adapter.capabilities.family === 'postgres'
  const usersT = isPg ? 'auth.users' : 'auth_users'
  const identsT = isPg ? 'auth.identities' : 'auth_identities'
  const users = await all(adapter, `SELECT * FROM ${usersT} ORDER BY id`).catch(() => [])
  const idents = await all(adapter, `SELECT * FROM ${identsT}`).catch(() => [])
  return users.map((u) => {
    const row = canonicalRow(u)
    return {
      id: String(u.id),
      email: u.email == null ? null : String(u.email),
      encrypted_password: u.encrypted_password == null ? null : String(u.encrypted_password),
      row,
      identities: idents
        .filter((i) => String(i.user_id) === String(u.id))
        .map((i) => canonicalRow(i)),
    }
  })
}

/** The composition reads object bytes (it owns the blob adapter); we only need metadata rows. */
export interface StorageReader {
  objects(): Promise<
    {
      bucket: string
      path: string
      size: number
      sha256: string
      contentType: string | null
      cacheControl: string | null
      isPublic: boolean
      bytes: Uint8Array
    }[]
  >
}

export async function fingerprintSource(
  adapter: DatabaseAdapter,
  schema: SchemaIR,
  storage: StorageReader,
): Promise<Fingerprint> {
  const counts: Record<string, number> = {}
  const multi: Record<string, string> = {}
  for (const t of schema.tables) {
    const rows = (await all(adapter, `SELECT * FROM ${q(t.name)}`)).map((r) =>
      canonicalRowTyped(r, t),
    )
    counts[t.name] = rows.length
    multi[t.name] = multisetHash(rows)
  }
  const seqs = await readSequences(adapter, schema)
  const users = await readAuthUsers(adapter)
  const objs = await storage.objects()
  return {
    family: adapter.capabilities.family === 'postgres' ? 'postgres' : 'sqlite',
    schemaHash: sha256Hex(canonicalJson(schema as unknown as Json)),
    tableRowCounts: counts,
    tableMultisetHash: multi,
    sequences: Object.fromEntries(
      Object.entries(seqs).map(([k, v]) => [k, { last: v.last, increment: v.increment }]),
    ),
    authUserCount: users.length,
    storageObjectCount: objs.length,
  }
}

export async function exportSource(input: {
  adapter: DatabaseAdapter
  schema: SchemaIR
  policies: Json
  storage: StorageReader
  planId: string
  preserveSessions: boolean
  legacySigningKey: { kid: string; jwk: Json } | null
}): Promise<UpgradeBundle> {
  const { adapter, schema } = input
  const order = topoOrder(schema)
  const tableRows: Record<string, Record<string, Json>[]> = {}
  for (const name of order) {
    const table = schema.tables.find((t) => t.name === name)
    tableRows[name] = (await all(adapter, `SELECT * FROM ${q(name)}`)).map((r) =>
      table ? canonicalRowTyped(r, table) : canonicalRow(r),
    )
  }
  const seqs = await readSequences(adapter, schema)
  const users = await readAuthUsers(adapter)
  const objs = await input.storage.objects()
  const storageObjects: StorageObjectRecord[] = objs.map((o) => ({
    bucket: o.bucket,
    path: o.path,
    size: o.size,
    sha256: o.sha256,
    contentType: o.contentType,
    cacheControl: o.cacheControl,
    isPublic: o.isPublic,
    bytesBase64: Buffer.from(o.bytes).toString('base64'),
  }))
  return {
    planId: input.planId,
    source: await fingerprintSource(adapter, schema, input.storage),
    schema,
    authUsers: users,
    tableOrder: order,
    tableRows,
    sequences: seqs,
    policies: input.policies,
    storageObjects,
    legacySigningKey: input.preserveSessions ? input.legacySigningKey : null,
  }
}
