// Standalone SupaKernel server for the benchmark (contract §23.1). Kernel + gateway over
// node:sqlite with the same durability, seeds 10k rows, exposes `/_bench/durability`, prints
// `READY <url>` once its first CRUD round-trips. No RLS / Auth / Storage in the workload.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seededRandom, systemClock } from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink } from '@supakernel/ports'
import { serveNode } from '@supakernel/runtime-node'

const PORT = Number(process.env.PORT ?? 3112)
const DB_PATH = process.env.BENCH_DB_URL ?? ':memory:'
const ROWS = Number(process.env.BENCH_ROWS ?? 10_000)
const TENANTS = Number(process.env.BENCH_TENANTS ?? 20)

import { rmSync } from 'node:fs'

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  try {
    rmSync((process.env.BENCH_DB_URL ?? '') + suffix)
  } catch {}
}
const adapter = openNodeSqlite({ path: DB_PATH })
await adapter.execute(sql('PRAGMA journal_mode = WAL'))
await adapter.execute(sql('PRAGMA foreign_keys = ON'))
await adapter.execute(sql('PRAGMA synchronous = NORMAL'))
await adapter.execute(
  sql(
    `CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, body TEXT NOT NULL, done SK_BOOL NOT NULL, created_at SK_TEXT_TSTZ NOT NULL)`,
  ),
)
await adapter.execute(sql('CREATE INDEX todos_tenant_idx ON todos(tenant_id)'))

const schema = {
  version: 1,
  tables: [
    {
      name: 'todos',
      columns: [
        {
          name: 'id',
          type: 'int32',
          nullable: false,
          default: { kind: 'identity', sequence: 'todos_id_seq' },
          generated: false,
        },
        { name: 'tenant_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'body', type: 'text', nullable: false, default: null, generated: false },
        { name: 'done', type: 'bool', nullable: false, default: null, generated: false },
        {
          name: 'created_at',
          type: 'timestamptz',
          nullable: false,
          default: null,
          generated: false,
        },
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [{ name: 'todos_tenant_idx', columns: ['tenant_id'], unique: false, where: null }],
    },
  ],
  sequences: [
    {
      name: 'todos_id_seq',
      ownedBy: 'todos.id',
      start: '1',
      increment: '1',
      min: '1',
      max: '9223372036854775807',
      cycle: false,
    },
  ],
  policies: [],
}

const kernel = await KernelInstance.create({
  projectRef: 'bench',
  serverSecret: 'bench-secret',
  runtime: 'node',
  adapter,
  blob: openFsBlob({ root: mkdtempSync(join(tmpdir(), 'sk-bench-')) }),
  schema,
  policies: [],
  ports: { clock: systemClock(), random: seededRandom('bench'), mail: createMemoryMailSink() },
  management: { token: 'bench' },
})
const secret = kernel.authService.apiKeys.secret

// seed 10k
for (let i = 0; i < ROWS; i += 500) {
  const values = []
  const params = []
  for (let k = 0; k < 500 && i + k < ROWS; k++) {
    const n = i + k + 1
    values.push(`(?,?,?,?,?)`)
    params.push(
      n,
      `t${(n % TENANTS) + 1}`,
      `todo #${n}`,
      n % 3 === 0 ? 1 : 0,
      '2026-01-01T00:00:00Z',
    )
  }
  await adapter.execute(
    sql(
      `INSERT INTO todos (id, tenant_id, body, done, created_at) VALUES ${values.join(',')}`,
      params,
    ),
  )
}
await adapter
  .execute(
    sql(
      `INSERT INTO sqlite_sequence(name, seq) VALUES ('todos', ?) ON CONFLICT(name) DO UPDATE SET seq = ?`,
      [ROWS, ROWS],
    ),
  )
  .catch(() => {})

const app = createGateway({ kernel, maxBodyBytes: 10 * 1024 * 1024 })

const http = await serveNode({
  port: PORT,
  fetch: async (req) => {
    const u = new URL(req.url)
    if (u.pathname === '/_bench/durability') {
      const jm = (await adapter.execute(sql('PRAGMA journal_mode'))).rows[0]
      const fk = (await adapter.execute(sql('PRAGMA foreign_keys'))).rows[0]
      const sy = (await adapter.execute(sql('PRAGMA synchronous'))).rows[0]
      return new Response(
        JSON.stringify({
          journalMode: jm?.journal_mode ?? 'unknown',
          foreignKeys: Number(fk?.foreign_keys ?? 0) === 1,
          synchronous: String(sy?.synchronous ?? 'unknown'),
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    return app.fetch(req)
  },
})

const check = await fetch(`${http.url}/rest/v1/todos?select=id&limit=1`, {
  headers: { apikey: secret, authorization: `Bearer ${secret}` },
})
if (!check.ok) {
  console.error('supakernel first CRUD failed', check.status)
  process.exit(1)
}
process.env.BENCH_SUPAKERNEL_KEY = secret
console.log(`READY ${http.url} ${secret}`)

const shutdown = async () => {
  await http.close().catch(() => {})
  await kernel.dispose().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
