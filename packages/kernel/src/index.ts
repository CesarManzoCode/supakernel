// SupaKernel kernel — composes the domain services for one project and owns their lifecycle
// (contract §6.3, §16, §30 L9). Adapters enter by injection; nothing here imports a concrete
// adapter or Hono.

import { AuthService, authSchemaStatements, createAuthHandler } from '@supakernel/auth'
import type {
  Family,
  Json,
  PolicyRule,
  Principal,
  RuntimeId,
  SchemaIR,
} from '@supakernel/contracts'
import { createDataHandler } from '@supakernel/data'
import {
  buildCapabilities,
  createManagementHandler,
  createMcpServer,
  ensureMigrationTable,
  type ManagementProject,
} from '@supakernel/management'
import type {
  BlobAdapter,
  ClockPort,
  DatabaseAdapter,
  MailPort,
  RandomPort,
} from '@supakernel/ports'
import {
  OutboxDispatcher,
  outboxSchemaStatements,
  outboxTriggerStatements,
  RealtimeConnection,
} from '@supakernel/realtime'
import { createStorageHandler, StorageService, storageSchemaStatements } from '@supakernel/storage'

export interface KernelPorts {
  readonly clock: ClockPort
  readonly random: RandomPort
  readonly mail: MailPort
}

export interface KernelConfig {
  readonly projectRef: string
  readonly serverSecret: string
  readonly runtime: RuntimeId
  readonly adapter: DatabaseAdapter
  readonly blob: BlobAdapter
  readonly schema: SchemaIR
  readonly policies?: readonly PolicyRule[]
  readonly ports: KernelPorts
  readonly management?: {
    readonly queryEnabled?: boolean
    readonly loopbackOnly?: boolean
    readonly token?: string
  }
  readonly realtimeManagedTables?: readonly string[]
}

type Handler = (request: Request) => Promise<Response>

export class KernelInstance {
  readonly projectRef: string
  readonly family: Family
  readonly auth: Handler
  readonly data: Handler
  readonly storage: Handler
  readonly management: Handler
  readonly authService: AuthService
  readonly storageService: StorageService
  readonly dispatcher: OutboxDispatcher
  readonly mcp: ReturnType<typeof createMcpServer>

  private readonly config: KernelConfig
  private readonly connections = new Set<RealtimeConnection>()
  private disposed = false
  private draining = false

  private constructor(config: KernelConfig, auth: AuthService, storage: StorageService) {
    this.config = config
    this.projectRef = config.projectRef
    this.family = config.adapter.capabilities.family
    this.authService = auth
    this.storageService = storage
    this.dispatcher = new OutboxDispatcher(config.adapter, this.family)

    this.data = this.guard(
      createDataHandler({
        adapter: config.adapter,
        schema: config.schema,
        policies: config.policies ?? config.schema.policies,
        family: this.family,
        now: () => config.ports.clock.now(),
        resolvePrincipal: (headers) => auth.resolvePrincipal(headers),
      }),
    )
    this.auth = this.guard(createAuthHandler(auth))
    this.storage = this.guard(
      createStorageHandler({
        service: storage,
        resolvePrincipal: (headers) => auth.resolvePrincipal(headers),
      }),
    )

    const projects: ManagementProject[] = [
      {
        ref: config.projectRef,
        name: config.projectRef,
        adapter: config.adapter,
        schema: () => config.schema,
        apiKeys: () => [
          { name: 'anon', type: 'publishable', prefix: 'sb_publishable' },
          { name: 'service_role', type: 'secret', prefix: 'sb_secret' },
        ],
      },
    ]
    const managementHandler = createManagementHandler({
      projects: () => projects,
      authorize: (headers) => this.authorizeManagement(headers),
      queryEnabled: config.management?.queryEnabled ?? false,
      loopbackOnly: config.management?.loopbackOnly ?? true,
      peerIsLoopback: (headers) => headers.get('x-sk-peer') === 'loopback',
      capabilities: () => this.capabilities(),
      health: () => this.health(),
      queryTimeoutMs: 5000,
    })
    this.management = this.guard(managementHandler)
    this.mcp = createMcpServer({
      handler: managementHandler,
      managementToken: config.management?.token ?? 'sk_mgmt_dev',
      baseUrl: `http://${config.projectRef}.management.local`,
    })
  }

  static async create(config: KernelConfig): Promise<KernelInstance> {
    const family: Family = config.adapter.capabilities.family
    for (const stmt of authSchemaStatements(family)) {
      await config.adapter.execute({ text: stmt, parameters: [] })
    }
    for (const stmt of storageSchemaStatements(family)) {
      await config.adapter.execute({ text: stmt, parameters: [] })
    }
    await ensureMigrationTable(config.adapter)
    for (const stmt of outboxSchemaStatements(family)) {
      await config.adapter.execute({ text: stmt, parameters: [] }).catch(() => undefined)
    }
    const managed = new Set(config.realtimeManagedTables ?? config.schema.tables.map((t) => t.name))
    for (const table of config.schema.tables) {
      if (!managed.has(table.name)) continue
      for (const stmt of outboxTriggerStatements(family, {
        name: table.name,
        columns: table.columns.map((c) => c.name),
        primaryKey: table.primaryKey,
      })) {
        await config.adapter.execute({ text: stmt, parameters: [] }).catch(() => undefined)
      }
    }
    const auth = await AuthService.create({
      adapter: config.adapter,
      ports: config.ports,
      config: { projectRef: config.projectRef, serverSecret: config.serverSecret },
    })
    const storage = new StorageService({
      adapter: config.adapter,
      blob: config.blob,
      crypto: auth.crypto,
      signingKeyId: auth.signingKeyId,
      ports: { clock: config.ports.clock, random: config.ports.random },
      projectRef: config.projectRef,
      ...(config.policies ? { policies: config.policies } : {}),
    })
    return new KernelInstance(config, auth, storage)
  }

  realtimeConnection(principal: Principal): RealtimeConnection {
    if (this.disposed) throw new Error('SK_KERNEL_DISPOSED')
    const conn = new RealtimeConnection(
      {
        schema: this.config.schema,
        policies: this.config.policies ?? this.config.schema.policies,
        issuer: this.authService.config.issuer,
        audience: this.authService.config.audience,
        now: () => this.config.ports.clock.now(),
        epochMillis: () => this.config.ports.clock.epochMillis(),
        anonPrincipal: principal,
        verifyToken: async (token) => {
          const p = await this.authService.resolvePrincipal(
            new Headers({
              authorization: `Bearer ${token}`,
              apikey: this.authService.apiKeys.publishable,
            }),
          )
          return p.kind === 'user' ? p : null
        },
      },
      principal,
    )
    this.connections.add(conn)
    return conn
  }

  async pumpRealtime(): Promise<number> {
    if (this.disposed || this.draining) return 0
    return (await this.dispatcher.pump()).length
  }

  capabilities(): Json {
    return buildCapabilities({
      runtime: this.config.runtime,
      databaseFamilies: [this.family],
      services: ['data', 'auth', 'storage', 'realtime', 'management'],
      exclusions: ['rpc', 'broadcast', 'presence', 'oauth', 'mfa', 'edge-functions'],
      coreHash: 'sk-core-1',
    })
  }

  health(): Json {
    return {
      healthy: !this.disposed && this.dispatcher.healthy,
      services: {
        data: !this.disposed,
        auth: !this.disposed,
        storage: !this.disposed,
        realtime: this.dispatcher.healthy,
        management: !this.disposed,
      },
      realtime_cursor: this.dispatcher.cursor,
    }
  }

  private authorizeManagement(headers: Headers): boolean {
    const bearer = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const expected = this.config.management?.token ?? 'sk_mgmt_dev'
    // a Management token is opaque (no dots) and lives in a separate keyspace from Data JWTs (§16)
    return bearer.length > 0 && bearer === expected && !bearer.includes('.')
  }

  /** Deterministic clean disposal (contract §6.3): stop accepting work, drain, close adapters. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.draining = true
    try {
      await this.dispatcher.pump()
    } catch {
      /* ignore */
    }
    this.connections.clear()
    this.disposed = true
    await this.config.adapter.close().catch(() => undefined)
    await Promise.resolve(this.config.blob[Symbol.asyncDispose]?.()).catch(() => undefined)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private guard(handler: Handler): Handler {
    return async (request: Request): Promise<Response> => {
      if (this.disposed) {
        return new Response(JSON.stringify({ message: 'server shutting down' }), { status: 503 })
      }
      return handler(request)
    }
  }
}

/** A `ProjectRegistry` for the multi-project runtimes (Node / Bun / Deno) — contract §6.3. */
export class ProjectRegistry {
  private readonly byRef = new Map<string, KernelInstance>()

  async register(config: KernelConfig): Promise<KernelInstance> {
    if (this.byRef.has(config.projectRef))
      throw new Error(`SK_KERNEL_DUPLICATE: ${config.projectRef}`)
    const instance = await KernelInstance.create(config)
    this.byRef.set(config.projectRef, instance)
    return instance
  }
  get(ref: string): KernelInstance | undefined {
    return this.byRef.get(ref)
  }
  list(): KernelInstance[] {
    return [...this.byRef.values()]
  }
  async unregister(ref: string): Promise<void> {
    const i = this.byRef.get(ref)
    if (i) {
      await i.dispose()
      this.byRef.delete(ref)
    }
  }
  async disposeAll(): Promise<void> {
    await Promise.all([...this.byRef.values()].map((i) => i.dispose()))
    this.byRef.clear()
  }
}
