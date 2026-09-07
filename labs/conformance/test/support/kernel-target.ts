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
import type { Family, Json, PolicyRule, Principal, SchemaIR } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { compilePostgresRls } from '@supakernel/policy'
import { createMemoryMailSink, type DatabaseAdapter } from '@supakernel/ports'
import { outboxTriggerStatements } from '@supakernel/realtime'
import {
  type ControlChannel,
  createTableSql,
  type PortableTable,
  type Target,
  type TargetClient,
  type TargetHealth,
  type TargetSession,
} from '../../src/index.js'

const CONF_SCHEMA: SchemaIR = { version: 1, tables: [], sequences: [], policies: [] }
const SERVICE: Principal = {
  kind: 'service',
  subjectId: null,
  tenantId: 'local',
  role: 'service_role',
  sessionId: null,
  claims: {},
  credentialSource: 'secret_key',
}

async function compose(family: Family): Promise<TargetSession & { dispose(): Promise<void> }> {
  const controlFamily: 'postgres' | 'sqlite' = family === 'postgres' ? 'postgres' : 'sqlite'
  const adapter: DatabaseAdapter =
    family === 'postgres'
      ? openPostgres({ url: process.env.SUPAKERNEL_TEST_PG_URL as string })
      : openNodeSqlite({ path: ':memory:' })
  const blobDir = await mkdtemp(join(tmpdir(), 'sk-conf-blob-'))
  const blob = openFsBlob({ root: blobDir })
  const mail = createMemoryMailSink()
  const kernel = await KernelInstance.create({
    projectRef: 'local',
    serverSecret: 'conformance-server-secret',
    runtime: 'node',
    adapter,
    blob,
    schema: CONF_SCHEMA,
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
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return Promise.resolve(app.fetch(new Request(url, init)))
  }
  const keyFor = (seat: string): string =>
    seat === 'service' ? kernel.authService.apiKeys.secret : kernel.authService.apiKeys.publishable

  const client: TargetClient = {
    baseUrl: 'http://sk.conformance',
    client: (seat) =>
      createClient('http://sk.conformance', keyFor(seat), {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: fetchImpl as typeof fetch },
      }) as unknown as ReturnType<TargetClient['client']>,
    fetch: (path, init) => app.fetch(new Request(`http://sk.conformance${path}`, init)),
    managementToken: () => 'sk_mgmt_conformance',
  }

  const control: ControlChannel = {
    family: controlFamily,
    async reset() {
      for (const t of created) {
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
      await exec(createTableSql(table, controlFamily))
      created.add(table.name)
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
      for (const stmt of compilePostgresRls({ ...CONF_SCHEMA, policies: rules }, rules)) {
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
        return (await exec(`SELECT * FROM "${sel.table}"${order}`)) as unknown as Json
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
    open: (_scenario) => compose(family),
  }
}
