import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createManagementHandler,
  createMcpServer,
  ensureMigrationTable,
  MCP_ALLOWED_TOOLS,
} from '../src/index.js'

const SCHEMA = {
  version: 1 as const,
  tables: [
    {
      name: 'items',
      columns: [
        { name: 'id', type: 'int32' as const, nullable: false, default: null, generated: false },
        { name: 'label', type: 'text' as const, nullable: false, default: null, generated: false },
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

describe('Management MCP — real allowed tools (contract §16, §30 L9)', () => {
  let adapter: ReturnType<typeof openNodeSqlite>
  let mcp: ReturnType<typeof createMcpServer>

  beforeEach(async () => {
    adapter = openNodeSqlite({ path: ':memory:' })
    await adapter.execute(sql('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)'))
    await adapter.execute(sql("INSERT INTO items VALUES (1,'x'),(2,'y'),(3,'z')"))
    await ensureMigrationTable(adapter)
    const handler = createManagementHandler({
      projects: () => [
        { ref: 'proj', name: 'proj', adapter, schema: () => SCHEMA, apiKeys: () => [] },
      ],
      authorize: (h) => h.get('authorization') === 'Bearer sk_mgmt_tok',
      queryEnabled: true,
      loopbackOnly: true,
      peerIsLoopback: (h) => h.get('x-sk-peer') === 'loopback',
      capabilities: () => ({}),
      health: () => ({ healthy: true }),
      queryTimeoutMs: 5000,
    })
    mcp = createMcpServer({ handler, managementToken: 'sk_mgmt_tok', baseUrl: 'http://mcp.local' })
  })
  afterEach(async () => {
    await adapter.close()
  })

  const call = (name: string, args: Record<string, unknown> = {}) =>
    mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

  it('initialize + tools/list advertise exactly the allowlist', async () => {
    const init = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      'supakernel-management',
    )
    const list = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    expect(names.sort()).toEqual([...MCP_ALLOWED_TOOLS].sort())
  })

  it('list_projects / get_project', async () => {
    const projects = JSON.parse(text(await call('list_projects')))
    expect(projects[0].ref).toBe('proj')
    const one = JSON.parse(text(await call('get_project', { ref: 'proj' })))
    expect(one.ref).toBe('proj')
  })

  it('execute_sql runs a read-only SELECT and refuses a write', async () => {
    const rows = JSON.parse(
      text(
        await call('execute_sql', {
          project_ref: 'proj',
          query: 'SELECT count(*) AS n FROM items',
        }),
      ),
    )
    expect(rows[0].n).toBe(3)
    const bad = await call('execute_sql', {
      project_ref: 'proj',
      query: 'DELETE FROM items',
      read_only: true,
    })
    expect(text(bad)).toMatch(/SK_MGMT_QUERY_NOT_READ_ONLY|403/)
  })

  it('apply_migration + list_migrations + generate_typescript_types', async () => {
    await call('apply_migration', {
      project_ref: 'proj',
      name: 'add_note',
      query: 'ALTER TABLE items ADD COLUMN note TEXT',
    })
    const migs = JSON.parse(text(await call('list_migrations', { project_ref: 'proj' })))
    expect(migs.map((m: { name: string }) => m.name)).toContain('add_note')
    const types = JSON.parse(text(await call('generate_typescript_types', { project_ref: 'proj' })))
    expect(types.types).toContain('items: {')
  })

  it('an unknown tool returns a clear unsupported error, not a generic failure', async () => {
    const res = await call('drop_database', { name: 'prod' })
    expect(res.error?.code).toBe(-32601)
    expect(res.error?.message).toMatch(/unsupported tool.*Management subset/i)
  })

  it('a Management-audience token is required for the underlying calls', async () => {
    const badMcp = createMcpServer({
      handler: createManagementHandler({
        projects: () => [
          { ref: 'proj', name: 'proj', adapter, schema: () => SCHEMA, apiKeys: () => [] },
        ],
        authorize: (h) => h.get('authorization') === 'Bearer right',
        queryEnabled: true,
        loopbackOnly: false,
        peerIsLoopback: () => true,
        capabilities: () => ({}),
        health: () => ({}),
        queryTimeoutMs: 5000,
      }),
      managementToken: 'wrong',
      baseUrl: 'http://x',
    })
    const res = await badMcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    })
    expect(text(res)).toMatch(/Unauthorized/)
  })
})

function text(res: { result?: unknown; error?: unknown }): string {
  if (res.error) return JSON.stringify(res.error)
  const content = (res.result as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? JSON.stringify(res.result)
}
