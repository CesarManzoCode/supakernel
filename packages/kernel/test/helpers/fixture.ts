import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemClock, webRandom } from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import type { PolicyRule, SchemaIR } from '@supakernel/contracts'
import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { createMemoryMailSink } from '@supakernel/ports'
import { KernelInstance } from '../../src/index.js'

export const SCHEMA: SchemaIR = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        {
          name: 'id',
          type: 'text',
          nullable: false,
          default: { kind: 'uuidV4' },
          generated: false,
        },
        { name: 'tenant_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'owner_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'title', type: 'text', nullable: false, default: null, generated: false },
        { name: 'body', type: 'text', nullable: true, default: null, generated: false },
        {
          name: 'created_at',
          type: 'timestamptz',
          nullable: false,
          default: { kind: 'currentTimestamp' },
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

export const POLICIES: PolicyRule[] = [
  {
    id: 'notes_own',
    table: 'notes',
    action: 'select',
    role: 'authenticated',
    mode: 'permissive',
    using: {
      kind: 'compare',
      op: 'eq',
      left: { kind: 'column', table: 'notes', name: 'owner_id' },
      right: { kind: 'context', name: 'subjectId' },
    },
    check: null,
    fields: { read: '*', write: [], immutable: [] },
  },
  ...(['insert', 'update', 'delete'] as const).map((action) => ({
    id: `notes_${action}_own`,
    table: 'notes',
    action,
    role: 'authenticated',
    mode: 'permissive' as const,
    using:
      action === 'insert'
        ? null
        : {
            kind: 'compare' as const,
            op: 'eq' as const,
            left: { kind: 'column' as const, table: 'notes', name: 'owner_id' },
            right: { kind: 'context' as const, name: 'subjectId' as const },
          },
    check:
      action === 'delete'
        ? null
        : {
            kind: 'compare' as const,
            op: 'eq' as const,
            left: { kind: 'column' as const, table: 'notes', name: 'owner_id' },
            right: { kind: 'context' as const, name: 'subjectId' as const },
          },
    fields: {
      read: '*' as const,
      write: ['tenant_id', 'owner_id', 'title', 'body'] as string[],
      immutable: ['id', 'created_at'] as string[],
    },
  })),
]

const DDL = [
  'DROP TABLE IF EXISTS notes',
  `CREATE TABLE notes (
     id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
     tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
     created_at SK_TEXT_TSTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
]

export interface KernelFixture {
  kernel: KernelInstance
  cleanup(): Promise<void>
}

export async function makeKernel(
  opts: { managementToken?: string; queryEnabled?: boolean; loopbackOnly?: boolean } = {},
): Promise<KernelFixture> {
  const adapter = openNodeSqlite({ path: ':memory:' })
  for (const stmt of DDL) await adapter.execute(sql(stmt))
  const tmp = await mkdtemp(join(tmpdir(), 'sk-kernel-'))
  const kernel = await KernelInstance.create({
    projectRef: 'local',
    serverSecret: 'kernel-secret',
    runtime: 'node',
    adapter,
    blob: openFsBlob({ root: tmp }),
    schema: { ...SCHEMA, policies: POLICIES },
    policies: POLICIES,
    ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
    management: {
      token: opts.managementToken ?? 'sk_mgmt_test',
      queryEnabled: opts.queryEnabled ?? true,
      loopbackOnly: opts.loopbackOnly ?? true,
    },
  })
  return {
    kernel,
    cleanup: async () => {
      await kernel.dispose()
      await rm(tmp, { recursive: true, force: true })
    },
  }
}
