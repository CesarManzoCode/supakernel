// Upgrade harness (contract §17.2, §30 L12). Wires the port-only upgrade engine to a real
// SupaKernel source (PGlite — real PG sequences) and the Supabase-local target + Storage API.

import { authSchemaStatements, hashPassword, verifyPassword } from '@supakernel/auth'
import type { Json } from '@supakernel/contracts'
import { canonicalJson, sha256HexBytes, sql } from '@supakernel/contracts'
import { openPglite } from '@supakernel/db-pglite'
import { openPostgres } from '@supakernel/db-postgres'
import { compilePostgresRls } from '@supakernel/policy'
import type { DatabaseAdapter } from '@supakernel/ports'
import { NULL_FAULT_PORT } from '@supakernel/ports'
import {
  createPostgresIndex,
  createPostgresSequence,
  createPostgresTable,
  type ObjectTransfer,
  type StorageReader,
} from '@supakernel/schema'
import {
  UPGRADE_FIXTURE_EVENTS,
  UPGRADE_FIXTURE_NOTES,
  UPGRADE_FIXTURE_OBJECT,
  UPGRADE_FIXTURE_POLICIES,
  UPGRADE_FIXTURE_SCHEMA,
  UPGRADE_FIXTURE_USERS,
} from './upgrade-fixture.js'

export interface SupabaseTarget {
  readonly dbUrl: string
  readonly storageApiUrl: string
  readonly serviceKey: string
}

export function supabaseTargetFromEnv(): SupabaseTarget | null {
  const dbUrl = process.env.SUPAKERNEL_CONF_SB_DB_URL
  const api = process.env.SUPAKERNEL_CONF_SB_API_URL
  const serviceKey = process.env.SUPAKERNEL_CONF_SB_SERVICE_KEY
  if (!dbUrl || !api || !serviceKey) return null
  return { dbUrl, storageApiUrl: `${api}/storage/v1`, serviceKey }
}

const q = (n: string): string => `"${n}"`

/** Build + populate the SupaKernel source. */
export async function buildSource(): Promise<{
  adapter: DatabaseAdapter
  storage: StorageReader
  policies: Json
  dispose: () => Promise<void>
}> {
  const adapter = openPglite({ dataDir: 'memory://' })
  for (const stmt of authSchemaStatements('postgres')) await adapter.execute(sql(stmt))
  for (const seq of UPGRADE_FIXTURE_SCHEMA.sequences) {
    for (const s of createPostgresSequence(seq)) await adapter.execute(s)
  }
  for (const table of UPGRADE_FIXTURE_SCHEMA.tables) {
    await adapter.execute(createPostgresTable(UPGRADE_FIXTURE_SCHEMA, table))
    for (const idx of table.indexes) await adapter.execute(createPostgresIndex(table, idx))
  }
  for (const e of UPGRADE_FIXTURE_EVENTS) {
    await adapter.execute(
      sql(`INSERT INTO events (id, kind) VALUES ($1, $2)`, [e.id, e.kind] as never[]),
    )
  }
  await adapter.execute(sql(`SELECT setval('events_id_seq', 91, true)`))
  for (const n of UPGRADE_FIXTURE_NOTES) {
    await adapter.execute(
      sql(`INSERT INTO notes (id, owner, body, pinned) VALUES ($1,$2,$3,$4)`, [
        n.id,
        n.owner,
        n.body,
        n.pinned,
      ] as never[]),
    )
  }
  for (const u of UPGRADE_FIXTURE_USERS) {
    const enc = await hashPassword(u.password)
    await adapter.execute(
      sql(
        `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, role, aud, is_super_admin, is_anonymous, is_sso_user, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         VALUES ($1,$2,$3, now(), 'authenticated', 'authenticated', false, false, false, '{}', '{}', now(), now())`,
        [u.sub, u.email, enc] as never[],
      ),
    )
  }

  const objectBytes = new TextEncoder().encode(UPGRADE_FIXTURE_OBJECT.content)
  const storage: StorageReader = {
    async objects() {
      return [
        {
          bucket: UPGRADE_FIXTURE_OBJECT.bucket,
          path: UPGRADE_FIXTURE_OBJECT.path,
          size: objectBytes.byteLength,
          sha256: sha256HexBytes(objectBytes),
          contentType: UPGRADE_FIXTURE_OBJECT.contentType,
          cacheControl: 'max-age=3600',
          isPublic: false,
          bytes: objectBytes,
        },
      ]
    },
  }

  return {
    adapter,
    storage,
    policies: UPGRADE_FIXTURE_POLICIES as unknown as Json,
    dispose: () => adapter.close(),
  }
}

/** Open the Supabase-local target adapter + reset the `public` schema + storage. */
export async function buildTarget(target: SupabaseTarget): Promise<{
  adapter: DatabaseAdapter
  objects: ObjectTransfer
  deployPolicies: (t: DatabaseAdapter, policies: Json) => Promise<void>
  passwordLoginProbe: () => Promise<boolean>
  dispose: () => Promise<void>
}> {
  const adapter = openPostgres({ url: target.dbUrl })
  // disposable target: `public` must be empty of user tables before the upgrade (§17.2).
  const userTables = (
    await adapter.execute(sql(`SELECT tablename FROM pg_tables WHERE schemaname='public'`))
  ).rows as { tablename: string }[]
  for (const t of userTables) {
    await adapter
      .execute(sql(`DROP TABLE IF EXISTS public.${q(t.tablename)} CASCADE`))
      .catch(() => undefined)
  }
  const seqs = (
    await adapter.execute(sql(`SELECT sequencename FROM pg_sequences WHERE schemaname='public'`))
  ).rows as { sequencename: string }[]
  for (const s of seqs) {
    await adapter
      .execute(sql(`DROP SEQUENCE IF EXISTS public.${q(s.sequencename)} CASCADE`))
      .catch(() => undefined)
  }
  await adapter
    .execute(sql(`DELETE FROM auth.users WHERE email LIKE '%@upgrade.test'`))
    .catch(() => undefined)

  const hdr = {
    apikey: target.serviceKey,
    authorization: `Bearer ${target.serviceKey}`,
    'content-type': 'application/json',
  }
  const objects: ObjectTransfer = {
    async ensureBucket(bucket, isPublic) {
      await fetch(`${target.storageApiUrl}/bucket/${bucket}`, {
        method: 'DELETE',
        headers: hdr,
      }).catch(() => undefined)
      await fetch(`${target.storageApiUrl}/bucket`, {
        method: 'POST',
        headers: hdr,
        body: JSON.stringify({ id: bucket, name: bucket, public: isPublic }),
      })
    },
    async putObject(o) {
      const bytes = Uint8Array.from(atob(o.bytesBase64), (c) => c.charCodeAt(0))
      const res = await fetch(`${target.storageApiUrl}/object/${o.bucket}/${o.path}`, {
        method: 'POST',
        headers: {
          apikey: target.serviceKey,
          authorization: `Bearer ${target.serviceKey}`,
          'content-type': o.contentType ?? 'application/octet-stream',
          'cache-control': o.cacheControl ?? 'no-cache',
          'x-upsert': 'true',
        },
        body: bytes,
      })
      if (!res.ok) throw new Error(`putObject ${o.path}: ${res.status} ${await res.text()}`)
    },
    async statObject(bucket, path) {
      const res = await fetch(`${target.storageApiUrl}/object/authenticated/${bucket}/${path}`, {
        headers: { apikey: target.serviceKey, authorization: `Bearer ${target.serviceKey}` },
      })
      if (!res.ok) return null
      const buf = new Uint8Array(await res.arrayBuffer())
      return {
        size: buf.byteLength,
        sha256: sha256HexBytes(buf),
        contentType: res.headers.get('content-type'),
      }
    },
    async listObjects() {
      const out: { bucket: string; path: string }[] = []
      const walk = async (bucket: string, prefix: string): Promise<void> => {
        const res = await fetch(`${target.storageApiUrl}/object/list/${bucket}`, {
          method: 'POST',
          headers: hdr,
          body: JSON.stringify({ prefix, limit: 1000 }),
        })
        if (!res.ok) return
        const rows = (await res.json()) as { name: string; id: string | null }[]
        for (const r of rows) {
          if (!r.name) continue
          if (r.id === null) {
            await walk(bucket, `${prefix}${r.name}/`)
          } else {
            out.push({ bucket, path: `${prefix}${r.name}` })
          }
        }
      }
      await walk('upg-private', '')
      return out
    },
  }

  const deployPolicies = async (t: DatabaseAdapter, policies: Json): Promise<void> => {
    const rules = policies as unknown as import('@supakernel/contracts').PolicyRule[]
    for (const stmt of compilePostgresRls({ ...UPGRADE_FIXTURE_SCHEMA, policies: rules }, rules)) {
      await t.execute(stmt).catch(() => undefined)
    }
  }

  const passwordLoginProbe = async (): Promise<boolean> => {
    const rows = (
      await adapter.execute(
        sql(`SELECT encrypted_password FROM auth.users WHERE email = $1`, [
          'user-a@upgrade.test',
        ] as never[]),
      )
    ).rows as { encrypted_password: string }[]
    if (!rows[0]) return false
    return verifyPassword('correct-horse-a', rows[0].encrypted_password)
  }

  return { adapter, objects, deployPolicies, passwordLoginProbe, dispose: () => adapter.close() }
}

export { canonicalJson, NULL_FAULT_PORT }
