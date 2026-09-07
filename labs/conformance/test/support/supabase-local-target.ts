// Test-support wiring: `vendor.supabase-local@2.116.0` (contract §19.1). Control channel over
// the stack's own Postgres + GoTrue admin + Storage API; operations through the fixed public
// supabase-js client pointed at Kong.

import { createClient } from '@supabase/supabase-js'
import type { Json } from '@supakernel/contracts'
import postgres from 'postgres'
import {
  type ControlChannel,
  createTableSql,
  type PortableTable,
  type Target,
  type TargetClient,
  type TargetHealth,
  type TargetSession,
} from '../../src/index.js'

export interface SupabaseLocalConfig {
  readonly apiUrl: string
  readonly dbUrl: string
  readonly anonKey: string
  readonly serviceKey: string
  readonly mailpitUrl: string
}

export function supabaseLocalConfigFromEnv(): SupabaseLocalConfig | null {
  const apiUrl = process.env.SUPAKERNEL_CONF_SB_API_URL
  const dbUrl = process.env.SUPAKERNEL_CONF_SB_DB_URL
  const anonKey = process.env.SUPAKERNEL_CONF_SB_ANON_KEY
  const serviceKey = process.env.SUPAKERNEL_CONF_SB_SERVICE_KEY
  if (!apiUrl || !dbUrl || !anonKey || !serviceKey) return null
  return {
    apiUrl,
    dbUrl,
    anonKey,
    serviceKey,
    mailpitUrl: process.env.SUPAKERNEL_CONF_SB_MAILPIT_URL ?? 'http://127.0.0.1:54324',
  }
}

export function createSupabaseLocalTarget(cfg: SupabaseLocalConfig): Target {
  return {
    id: 'vendor.supabase-local',
    nature: 'vendor',
    gate: 'mandatory',
    capabilities: ['data', 'auth', 'storage', 'realtime'],
    async health(): Promise<TargetHealth> {
      try {
        const rest = await fetch(`${cfg.apiUrl}/rest/v1/`, { headers: { apikey: cfg.anonKey } })
        if (rest.status >= 500) return { ok: false, detail: `rest ${rest.status}` }
        const auth = await fetch(`${cfg.apiUrl}/auth/v1/health`, {
          headers: { apikey: cfg.anonKey },
        })
        return auth.ok
          ? { ok: true, detail: 'supabase-local healthy' }
          : { ok: false, detail: `auth ${auth.status}` }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },
    async open(_scenario): Promise<TargetSession> {
      const pg = postgres(cfg.dbUrl, { max: 4, onnotice: () => {} })
      const created = new Set<string>()
      const keyFor = (seat: string): string => (seat === 'service' ? cfg.serviceKey : cfg.anonKey)

      const client: TargetClient = {
        baseUrl: cfg.apiUrl,
        client: (seat) =>
          createClient(cfg.apiUrl, keyFor(seat), {
            auth: { persistSession: false, autoRefreshToken: false },
          }) as unknown as ReturnType<TargetClient['client']>,
        fetch: (path, init) => fetch(`${cfg.apiUrl}${path}`, init),
        managementToken: () => cfg.serviceKey,
      }

      const control: ControlChannel = {
        family: 'postgres',
        async reset() {
          for (const t of created)
            await pg.unsafe(`DROP TABLE IF EXISTS public."${t}" CASCADE`).catch(() => undefined)
          created.clear()
          await pg
            .unsafe(`DELETE FROM auth.users WHERE email LIKE '%@conformance.test'`)
            .catch(() => undefined)
          await pg
            .unsafe(`DELETE FROM storage.objects WHERE bucket_id LIKE 'conf-%'`)
            .catch(() => undefined)
          await pg
            .unsafe(`DELETE FROM storage.buckets WHERE id LIKE 'conf-%'`)
            .catch(() => undefined)
        },
        async createTable(table: PortableTable) {
          await pg.unsafe(
            createTableSql(table, 'postgres').replace('CREATE TABLE "', 'CREATE TABLE public."'),
          )
          created.add(table.name)
          await pg.unsafe(
            `GRANT ALL ON public."${table.name}" TO anon, authenticated, service_role`,
          )
          await pg
            .unsafe(`ALTER PUBLICATION supabase_realtime ADD TABLE public."${table.name}"`)
            .catch(() => undefined)
          await pg.unsafe(`NOTIFY pgrst, 'reload schema'`).catch(() => undefined)
        },
        async deployPolicies(_policies: Json) {
          // Data conformance is scoped to the PostgREST protocol surface (§11); RLS
          // enforcement equivalence is the separate `authorization` gate (§13).
        },
        async seed(table, rows) {
          for (const row of rows) {
            const keys = Object.keys(row)
            await pg.unsafe(
              `INSERT INTO public."${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys
                .map((_, i) => `$${i + 1}`)
                .join(',')})`,
              keys.map((k) => row[k] as never),
            )
          }
          await pg.unsafe(`NOTIFY pgrst, 'reload schema'`).catch(() => undefined)
        },
        async adminCreateUser(user) {
          const res = await fetch(`${cfg.apiUrl}/auth/v1/admin/users`, {
            method: 'POST',
            headers: {
              apikey: cfg.serviceKey,
              authorization: `Bearer ${cfg.serviceKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: user.email,
              password: user.password,
              email_confirm: true,
              user_metadata: user.data ?? {},
            }),
          })
          if (!res.ok)
            throw new Error(`supabase-local adminCreateUser ${res.status}: ${await res.text()}`)
        },
        async createBucket(bucket) {
          const res = await fetch(`${cfg.apiUrl}/storage/v1/bucket`, {
            method: 'POST',
            headers: {
              apikey: cfg.serviceKey,
              authorization: `Bearer ${cfg.serviceKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              id: bucket.name,
              name: bucket.name,
              public: bucket.public ?? false,
            }),
          })
          if (!res.ok && res.status !== 409)
            throw new Error(`supabase-local createBucket ${res.status}: ${await res.text()}`)
        },
        async registerRealtimeTable(table) {
          await pg
            .unsafe(`ALTER PUBLICATION supabase_realtime ADD TABLE public."${table}"`)
            .catch(() => undefined)
        },
        async capture(of, selector) {
          if (of === 'db-state') {
            const sel = selector as { table?: string; orderBy?: string }
            const rows = await pg.unsafe(
              `SELECT * FROM public."${sel.table}" ORDER BY ${sel.orderBy ? `"${sel.orderBy}"` : '1'}`,
            )
            return rows.map((r) => ({ ...r })) as unknown as Json
          }
          if (of === 'mail') {
            const res = await fetch(`${cfg.mailpitUrl}/api/v1/messages`)
            if (!res.ok) return []
            const body = (await res.json()) as {
              messages?: { To?: { Address: string }[]; Subject?: string }[]
            }
            return (body.messages ?? []).map((m) => ({
              to: m.To?.[0]?.Address ?? null,
              subject: m.Subject ?? null,
            })) as unknown as Json
          }
          return null
        },
      }

      return {
        control,
        client,
        async dispose() {
          await pg.end({ timeout: 5 }).catch(() => undefined)
        },
      }
    },
  }
}
