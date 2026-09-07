import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createManagementHandler,
  ensureMigrationTable,
  type ManagementProject,
} from '../src/index.js'

const SCHEMA = {
  version: 1 as const,
  tables: [
    {
      name: 'widgets',
      columns: [
        { name: 'id', type: 'int32' as const, nullable: false, default: null, generated: false },
        { name: 'name', type: 'text' as const, nullable: false, default: null, generated: false },
        {
          name: 'price',
          type: 'decimal' as const,
          nullable: true,
          default: null,
          generated: false,
        },
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

describe('Management API subset (contract §16, §30 L9)', () => {
  let adapter: ReturnType<typeof openNodeSqlite>
  let handler: (r: Request) => Promise<Response>
  const TOKEN = 'sk_mgmt_opaque'

  beforeEach(async () => {
    adapter = openNodeSqlite({ path: ':memory:' })
    await adapter.execute(
      sql('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price SK_TEXT_DEC)'),
    )
    await adapter.execute(sql("INSERT INTO widgets (id, name) VALUES (1, 'a'), (2, 'b')"))
    await ensureMigrationTable(adapter)
    const project: ManagementProject = {
      ref: 'proj-1',
      name: 'demo',
      adapter,
      schema: () => SCHEMA,
      apiKeys: () => [
        { name: 'anon', type: 'publishable', prefix: 'sb_publishable' },
        { name: 'service_role', type: 'secret', prefix: 'sb_secret' },
      ],
    }
    handler = createManagementHandler({
      projects: () => [project],
      authorize: (h) => h.get('authorization') === `Bearer ${TOKEN}`,
      queryEnabled: true,
      loopbackOnly: true,
      peerIsLoopback: (h) => h.get('x-sk-peer') === 'loopback',
      capabilities: () => ({ ok: true }),
      health: () => ({ healthy: true }),
      queryTimeoutMs: 5000,
    })
  })
  afterEach(async () => {
    await adapter.close()
  })

  const req = (path: string, init: RequestInit = {}): Request =>
    new Request(`http://mgmt${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-sk-peer': 'loopback',
        ...(init.headers as Record<string, string>),
      },
    })

  it('_system + capabilities need no auth; /v1 requires the Management token', async () => {
    expect((await handler(new Request('http://mgmt/_system/health'))).status).toBe(200)
    expect((await handler(new Request('http://mgmt/_system/openapi'))).status).toBe(200)
    expect(
      (await handler(new Request('http://mgmt/.well-known/supakernel-capabilities'))).status,
    ).toBe(200)
    expect((await handler(new Request('http://mgmt/v1/projects'))).status).toBe(401)
    // a Data JWT (has dots) is not a Management token
    expect(
      (
        await handler(
          new Request('http://mgmt/v1/projects', { headers: { authorization: 'Bearer a.b.c' } }),
        )
      ).status,
    ).toBe(401)
  })

  it('GET /v1/projects[/:ref] and api-keys (redacted)', async () => {
    const list = await (await handler(req('/v1/projects'))).json()
    expect(list[0].ref).toBe('proj-1')
    const one = await (await handler(req('/v1/projects/proj-1'))).json()
    expect(one.ref).toBe('proj-1')
    const keys = await (await handler(req('/v1/projects/proj-1/api-keys'))).json()
    expect(keys[0].api_key).toMatch(/\*{10,}/)
    expect(JSON.stringify(keys)).not.toMatch(/sb_secret_[A-Za-z0-9]{6}/)
  })

  it('database/query: single read-only SELECT works; writes / multi / dangerous functions are refused', async () => {
    const ok = await handler(
      req('/v1/projects/proj-1/database/query', {
        method: 'POST',
        body: JSON.stringify({ query: 'SELECT count(*) AS n FROM widgets', read_only: true }),
      }),
    )
    expect(ok.status).toBe(201)
    expect((await ok.json())[0].n).toBe(2)

    for (const q of [
      "UPDATE widgets SET name = 'x'",
      'SELECT 1; SELECT 2',
      "SELECT pg_read_file('/etc/passwd')",
      'DROP TABLE widgets',
    ]) {
      const bad = await handler(
        req('/v1/projects/proj-1/database/query', {
          method: 'POST',
          body: JSON.stringify({ query: q, read_only: true }),
        }),
      )
      expect(bad.status).toBeGreaterThanOrEqual(400)
    }
    // widgets untouched
    const check = await adapter.execute(sql('SELECT count(*) AS n FROM widgets'))
    expect(Number(check.rows[0]?.n)).toBe(2)
  })

  it('database/query is disabled and loopback-gated when configured so', async () => {
    const disabled = createManagementHandler({
      projects: () => [{ ref: 'p', name: 'p', adapter, schema: () => SCHEMA, apiKeys: () => [] }],
      authorize: () => true,
      queryEnabled: false,
      loopbackOnly: true,
      peerIsLoopback: () => false,
      capabilities: () => ({}),
      health: () => ({}),
      queryTimeoutMs: 5000,
    })
    const r1 = await disabled(
      new Request('http://m/v1/projects/p/database/query', {
        method: 'POST',
        body: '{"query":"SELECT 1"}',
      }),
    )
    expect(r1.status).toBe(403)

    const loopbackGated = createManagementHandler({
      projects: () => [{ ref: 'p', name: 'p', adapter, schema: () => SCHEMA, apiKeys: () => [] }],
      authorize: () => true,
      queryEnabled: true,
      loopbackOnly: true,
      peerIsLoopback: () => false,
      capabilities: () => ({}),
      health: () => ({}),
      queryTimeoutMs: 5000,
    })
    const r2 = await loopbackGated(
      new Request('http://m/v1/projects/p/database/query', {
        method: 'POST',
        body: '{"query":"SELECT 1"}',
      }),
    )
    expect(r2.status).toBe(403)
  })

  it('migrations: apply then list', async () => {
    const applied = await handler(
      req('/v1/projects/proj-1/database/migrations', {
        method: 'POST',
        body: JSON.stringify({
          name: 'add_color',
          query: 'ALTER TABLE widgets ADD COLUMN color TEXT',
        }),
      }),
    )
    expect(applied.status).toBe(201)
    const list = await (await handler(req('/v1/projects/proj-1/database/migrations'))).json()
    expect(list.map((m: { name: string }) => m.name)).toContain('add_color')
    const cols = await adapter.execute(
      sql("SELECT name FROM pragma_table_info('widgets') WHERE name = 'color'"),
    )
    expect(cols.rows).toHaveLength(1)
  })

  it('types/typescript is generated from the deployed schema', async () => {
    const { types } = await (await handler(req('/v1/projects/proj-1/types/typescript'))).json()
    expect(types).toContain('export interface Database')
    expect(types).toContain('widgets: {')
    expect(types).toContain('price?: string | null')
  })
})
