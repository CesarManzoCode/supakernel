// Test-support wiring: the SupaKernel product as a conformance target (contract §19.1
// `supakernel.pg` / `supakernel.sqlite`). Lives outside `src/` because it imports
// `@supabase/supabase-js`, whose shipped `.d.ts` does not satisfy the repo's
// `exactOptionalPropertyTypes` — the same reason every other package keeps supabase-js in
// test-only code (see packages/data).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { seededRandom, systemClock } from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import type { Family, Json, PolicyRule, Principal, ScenarioSpec } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { compilePostgresRls } from '@supakernel/policy'
import { createMemoryMailSink, type DatabaseAdapter } from '@supakernel/ports'
import { decodeFrame, encodeFrame, outboxTriggerStatements } from '@supakernel/realtime'
import { attachNodeRealtime, serveNode } from '@supakernel/runtime-node'
import {
  type ControlChannel,
  createTableSql,
  type PortableTable,
  scenarioSchemaIR,
  scenarioTables,
  type Target,
  type TargetClient,
  type TargetHealth,
  type TargetSession,
} from '../../src/index.js'

const SERVICE: Principal = {
  kind: 'service',
  subjectId: null,
  tenantId: 'local',
  role: 'service_role',
  sessionId: null,
  claims: {},
  credentialSource: 'secret_key',
}
const ANON: Principal = {
  kind: 'anonymous',
  subjectId: null,
  tenantId: 'local',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none',
}

async function compose(
  family: Family,
  scenario: ScenarioSpec,
): Promise<TargetSession & { dispose(): Promise<void> }> {
  const controlFamily: 'postgres' | 'sqlite' = family === 'postgres' ? 'postgres' : 'sqlite'
  const adapter: DatabaseAdapter =
    family === 'postgres'
      ? openPostgres({ url: process.env.SUPAKERNEL_TEST_PG_URL as string })
      : openNodeSqlite({ path: ':memory:' })
  const blobDir = await mkdtemp(join(tmpdir(), 'sk-conf-blob-'))
  const blob = openFsBlob({ root: blobDir })
  const mail = createMemoryMailSink()
  const scenarioSchema = scenarioSchemaIR(scenario)
  const declaredTables = scenarioTables(scenario)

  // Clean any leftovers from a prior scenario/run on the shared Postgres cluster before the
  // kernel installs its service schema.
  if (family === 'postgres') {
    for (const t of declaredTables) {
      await adapter
        .execute({ text: `DROP TABLE IF EXISTS "${t.name}" CASCADE`, parameters: [] })
        .catch(() => undefined)
    }
    await adapter.execute({ text: `DELETE FROM auth.users`, parameters: [] }).catch(() => undefined)
    await adapter
      .execute({ text: `DELETE FROM storage.objects`, parameters: [] })
      .catch(() => undefined)
    await adapter
      .execute({ text: `DELETE FROM storage.buckets`, parameters: [] })
      .catch(() => undefined)
    // The kernel's PG Data path runs `SET LOCAL ROLE`; the standard Supabase roles must
    // exist and hold table grants exactly as a real deployment provisions them.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await adapter
        .execute({
          text: `DO $$ BEGIN CREATE ROLE "${role}" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
          parameters: [],
        })
        .catch(() => undefined)
    }
    await adapter
      .execute({ text: `ALTER ROLE "service_role" BYPASSRLS`, parameters: [] })
      .catch(() => undefined)
  }

  const kernel = await KernelInstance.create({
    projectRef: 'local',
    serverSecret: 'conformance-server-secret',
    runtime: 'node',
    adapter,
    blob,
    schema: scenarioSchema,
    policies: [],
    ports: { clock: systemClock(), random: seededRandom('conformance'), mail },
    management: { token: 'sk_mgmt_conformance', queryEnabled: true, loopbackOnly: false },
    coreHash: 'sk-core-1',
  })
  const app = createGateway({ kernel, maxBodyBytes: 10 * 1024 * 1024 })
  const created = new Set<string>()
  const exec = async (
    text: string,
    params: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
    const res = await adapter.execute({ text, parameters: params as never[] })
    return (res.rows ?? []) as Record<string, unknown>[]
  }

  // A real HTTP + WebSocket server, so the fixed public client talks to the kernel over the
  // wire exactly as a deployment would — including realtime-js over ws@8.21.3 (contract §10,
  // §15, §19.2 — operations use the fixed public client).
  // biome-ignore lint/suspicious/noExplicitAny: realtime socket set
  const sockets = new Set<{ conn: any; socket: any }>()
  const http = await serveNode({
    fetch: (req: Request) => app.fetch(req),
    onServer: (server) => {
      attachNodeRealtime(server, {
        path: '/realtime/v1',
        handle: (socket) => {
          const conn = kernel.realtimeConnection(ANON)
          const entry = { conn, socket }
          sockets.add(entry)
          socket.onMessage(async (data: string) => {
            try {
              const out = await conn.handleFrame(decodeFrame(data))
              for (const f of out.frames) socket.send(encodeFrame(f))
              if (out.close) socket.close(out.close.code, out.close.reason)
            } catch {
              /* malformed frame ignored per codec contract */
            }
          })
          socket.onClose(() => sockets.delete(entry))
        },
      })
    },
  })
  const pumpTimer = setInterval(() => {
    void (async () => {
      const events = await kernel.dispatcher.pump().catch(() => [])
      for (const ev of events) {
        for (const { conn, socket } of sockets) {
          const out = conn.deliver(ev)
          for (const f of out.frames) socket.send(encodeFrame(f))
        }
      }
    })()
  }, 120)

  const keyFor = (seat: string): string =>
    seat === 'service' ? kernel.authService.apiKeys.secret : kernel.authService.apiKeys.publishable

  const client: TargetClient = {
    baseUrl: http.url,
    client: (seat) =>
      createClient(http.url, keyFor(seat), {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { apikey: keyFor(seat) } },
      }) as unknown as ReturnType<TargetClient['client']>,
    fetch: (path, init) => fetch(`${http.url}${path}`, init),
    managementToken: () => 'sk_mgmt_conformance',
  }

  const control: ControlChannel = {
    family: controlFamily,
    async reset() {
      for (const t of new Set([...created, ...declaredTables.map((d) => d.name)])) {
        await exec(
          `DROP TABLE IF EXISTS "${t}"${controlFamily === 'postgres' ? ' CASCADE' : ''}`,
        ).catch(() => undefined)
      }
      created.clear()
      await exec(`DELETE FROM ${family === 'postgres' ? 'auth.users' : 'auth_users'}`).catch(
        () => undefined,
      )
    },
    async createTable(table: PortableTable) {
      await exec(
        `DROP TABLE IF EXISTS "${table.name}"${controlFamily === 'postgres' ? ' CASCADE' : ''}`,
      ).catch(() => undefined)
      await exec(createTableSql(table, controlFamily))
      created.add(table.name)
      if (controlFamily === 'postgres') {
        await exec(`GRANT ALL ON "${table.name}" TO anon, authenticated, service_role`).catch(
          () => undefined,
        )
      }
      for (const stmt of outboxTriggerStatements(controlFamily, {
        name: table.name,
        columns: table.columns.map((c) => c.name),
        primaryKey: [...table.primaryKey],
      })) {
        await exec(stmt).catch(() => undefined)
      }
    },
    async deployPolicies(policies: Json) {
      if (controlFamily !== 'postgres') return
      const rules = policies as unknown as PolicyRule[]
      for (const stmt of compilePostgresRls({ ...scenarioSchema, policies: rules }, rules)) {
        await adapter.execute(stmt).catch(() => undefined)
      }
    },
    async seed(table, rows) {
      for (const row of rows) {
        const keys = Object.keys(row)
        const ph = keys.map((_, i) => (controlFamily === 'postgres' ? `$${i + 1}` : '?'))
        await exec(
          `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${ph.join(', ')})`,
          keys.map((k) => row[k]),
        )
      }
    },
    async adminCreateUser(user) {
      await kernel.authService.admin.createUser(SERVICE, {
        email: user.email,
        password: user.password,
        email_confirm: true,
        ...(user.data ? { user_metadata: user.data as Record<string, Json> } : {}),
      })
    },
    async createBucket(bucket) {
      await kernel.storageService
        .createBucket(SERVICE, { name: bucket.name, public: bucket.public ?? false })
        .catch(() => undefined)
    },
    async registerRealtimeTable() {},
    async capture(of, selector) {
      if (of === 'db-state') {
        const sel = selector as { table?: string; orderBy?: string }
        const order = sel.orderBy ? ` ORDER BY "${sel.orderBy}"` : ''
        const rows = await exec(`SELECT * FROM "${sel.table}"${order}`)
        // Canonicalize the raw storage representation to JSON types (SQLite bool -> 0/1) so
        // db-state observations compare like-for-like across families.
        const boolCols = new Set(
          (scenarioSchema.tables.find((t) => t.name === sel.table)?.columns ?? [])
            .filter((c) => c.type === 'bool')
            .map((c) => c.name),
        )
        return rows.map((r) => {
          const o: Record<string, unknown> = { ...r }
          for (const c of boolCols) if (typeof o[c] === 'number') o[c] = o[c] !== 0
          return o
        }) as unknown as Json
      }
      if (of === 'mail') {
        return mail.sent.map((m) => ({ to: m.to, templateId: m.templateId })) as unknown as Json
      }
      return null
    },
  }

  return {
    control,
    client,
    async dispose() {
      clearInterval(pumpTimer)
      for (const { socket } of sockets) {
        try {
          socket.close(1000, 'done')
        } catch {
          /* ignore */
        }
      }
      await http.close().catch(() => undefined)
      await kernel.dispose()
      await rm(blobDir, { recursive: true, force: true })
    },
  }
}

export function createKernelTarget(family: Family): Target {
  const id = family === 'postgres' ? 'supakernel.pg' : 'supakernel.sqlite'
  return {
    id,
    nature: 'product',
    gate: 'mandatory',
    capabilities: ['data', 'auth', 'storage', 'realtime', 'management'],
    async health(): Promise<TargetHealth> {
      if (family === 'postgres' && !process.env.SUPAKERNEL_TEST_PG_URL) {
        return { ok: false, detail: 'SUPAKERNEL_TEST_PG_URL not set' }
      }
      return { ok: true, detail: `${id} in-process` }
    },
    open: (scenario) => compose(family, scenario),
  }
}
