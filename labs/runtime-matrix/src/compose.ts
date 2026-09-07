import { seededRandom, systemClock } from '@supakernel/auth'
import type { PolicyRule, RuntimeId, SchemaIR } from '@supakernel/contracts'
import { FIXTURE_TABLE } from '@supakernel/fixture-app'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance, type KernelPorts } from '@supakernel/kernel'
import { compilePostgresRls } from '@supakernel/policy'
import { type BlobAdapter, createMemoryMailSink, type DatabaseAdapter } from '@supakernel/ports'
import { RUNTIME_PROFILES } from './manifest.js'

/** The table the fixture app drives, as SupaKernel schema IR. */
export const FIXTURE_SCHEMA: SchemaIR = {
  version: 1,
  tables: [
    {
      name: FIXTURE_TABLE,
      columns: [
        { name: 'id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'owner_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'title', type: 'text', nullable: false, default: null, generated: false },
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [],
    },
  ],
  sequences: [],
  policies: [],
}

const ownerEqSubject = {
  kind: 'compare' as const,
  op: 'eq' as const,
  left: { kind: 'column' as const, table: FIXTURE_TABLE, name: 'owner_id' },
  right: { kind: 'context' as const, name: 'subjectId' as const },
}

const fields = { read: '*' as const, write: '*' as const, immutable: ['id'] }

/** Default-deny everywhere; an authenticated principal reaches only its own rows. */
export const FIXTURE_POLICIES: readonly PolicyRule[] = [
  {
    id: 'sel',
    table: FIXTURE_TABLE,
    action: 'select',
    role: 'authenticated',
    mode: 'permissive',
    using: ownerEqSubject,
    check: null,
    fields,
  },
  {
    id: 'ins',
    table: FIXTURE_TABLE,
    action: 'insert',
    role: 'authenticated',
    mode: 'permissive',
    using: null,
    check: ownerEqSubject,
    fields,
  },
  {
    id: 'upd',
    table: FIXTURE_TABLE,
    action: 'update',
    role: 'authenticated',
    mode: 'permissive',
    using: ownerEqSubject,
    check: ownerEqSubject,
    fields,
  },
  {
    id: 'del',
    table: FIXTURE_TABLE,
    action: 'delete',
    role: 'authenticated',
    mode: 'permissive',
    using: ownerEqSubject,
    check: null,
    fields,
  },
]

export const FIXTURE_CREATE_TABLE: string = `CREATE TABLE ${FIXTURE_TABLE} (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL)`

export interface ComposeOptions {
  readonly adapter: DatabaseAdapter
  readonly blob: BlobAdapter
  readonly runtime: RuntimeId
  readonly managementQueryEnabled?: boolean
  readonly coreHash?: string
  readonly ports?: Partial<KernelPorts>
  /** Skip `CREATE TABLE` + schema install when the database is already provisioned (restart). */
  readonly restart?: boolean
}

export interface Composed {
  readonly kernel: KernelInstance
  readonly fetch: (request: Request) => Promise<Response>
  dispose(): Promise<void>
}

/** Compose the kernel + gateway for one runtime against injected adapters (contract §30 L10). */
export async function composeKernel(opts: ComposeOptions): Promise<Composed> {
  const family = opts.adapter.capabilities.family
  const profile = RUNTIME_PROFILES[opts.runtime]
  if (!opts.restart) {
    await opts.adapter.execute({ text: FIXTURE_CREATE_TABLE, parameters: [] })
    if (family === 'postgres') {
      // PG family runs native RLS: deploy `CREATE POLICY` + the `sk.*` helpers + roles.
      for (const stmt of compilePostgresRls(
        { ...FIXTURE_SCHEMA, policies: FIXTURE_POLICIES },
        FIXTURE_POLICIES,
      )) {
        await opts.adapter.execute(stmt)
      }
    }
  }
  const ports: KernelPorts = {
    clock: opts.ports?.clock ?? systemClock(),
    random: opts.ports?.random ?? seededRandom('runtime-matrix'),
    mail: opts.ports?.mail ?? createMemoryMailSink(),
  }
  const kernel = await KernelInstance.create({
    projectRef: 'local',
    serverSecret: 'runtime-matrix-secret',
    runtime: opts.runtime,
    adapter: opts.adapter,
    blob: opts.blob,
    schema: { ...FIXTURE_SCHEMA, policies: FIXTURE_POLICIES },
    policies: FIXTURE_POLICIES,
    ports,
    management: { token: 'sk_mgmt_matrix', queryEnabled: opts.managementQueryEnabled ?? false },
    limits: profile.limits,
    services: profile.services,
    exclusions: profile.exclusions,
    ...(opts.restart ? { skipSchemaInstall: true } : {}),
    ...(opts.coreHash ? { coreHash: opts.coreHash } : {}),
  })
  const app = createGateway({ kernel, maxBodyBytes: kernel.limits.maxRequestBodyBytes })
  return {
    kernel,
    fetch: (request: Request) => Promise.resolve(app.fetch(request)),
    dispose: () => kernel.dispose(),
  }
}
