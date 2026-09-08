// Standalone BKND server for the benchmark (contract §23.1). Boots bknd (node adapter,
// SQLite), applies the todos entity config, enforces the required durability, seeds 10k rows,
// exposes `/_bench/durability`, then prints `READY <url>` once its first CRUD round-trips.

import { createServer } from 'node:http'
import { boolean as bkBoolean, datetime as bkDatetime, text as bkText, em, entity } from 'bknd'
import { createApp, nodeSqlite } from 'bknd/adapter/node'

const PORT = Number(process.env.PORT ?? 3111)
const DB_URL = process.env.BENCH_DB_URL ?? ':memory:'
const ROWS = Number(process.env.BENCH_ROWS ?? 10_000)
const TENANTS = Number(process.env.BENCH_TENANTS ?? 20)

import { rmSync } from 'node:fs'

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  try {
    rmSync((process.env.BENCH_DB_URL ?? '') + suffix)
  } catch {}
}
const app = await createApp({ connection: nodeSqlite({ url: DB_URL }) })
await app.build()

// entity config
const dataCfg = em({
  todos: entity('todos', {
    tenant_id: bkText(),
    body: bkText(),
    done: bkBoolean(),
    created_at: bkDatetime(),
  }),
}).toJSON()
await app.fetch(
  new Request(`http://x/api/system/config/set/data`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dataCfg),
  }),
)

// durability: match the contract's required SQLite settings
const kysely = app.connection.kysely
async function pragma(q) {
  try {
    const r = await kysely.executeQuery({ sql: q, parameters: [], query: { kind: 'RawNode' } })
    return r?.rows?.[0]
  } catch {
    return undefined
  }
}
await pragma('PRAGMA journal_mode = WAL')
await pragma('PRAGMA foreign_keys = ON')
await pragma('PRAGMA synchronous = NORMAL')
await pragma('CREATE INDEX IF NOT EXISTS todos_tenant_idx ON todos(tenant_id)')

// seed 10k
const mut = app.em.mutator('todos')
for (let i = 0; i < ROWS; i += 500) {
  const batch = []
  for (let k = 0; k < 500 && i + k < ROWS; k++) {
    const n = i + k + 1
    batch.push({
      tenant_id: `t${(n % TENANTS) + 1}`,
      body: `todo #${n}`,
      done: n % 3 === 0,
      created_at: '2026-01-01T00:00:00Z',
    })
  }
  await mut.insertMany(batch)
}

const server = createServer(async (req, res) => {
  if (req.url === '/_bench/durability') {
    const jm = await pragma('PRAGMA journal_mode')
    const fk = await pragma('PRAGMA foreign_keys')
    const sy = await pragma('PRAGMA synchronous')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        journalMode: jm?.journal_mode ?? 'unknown',
        foreignKeys: (fk?.foreign_keys ?? 0) === 1,
        synchronous: String(sy?.synchronous ?? 'unknown'),
      }),
    )
    return
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  })
  const response = await app.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const url = `http://127.0.0.1:${PORT}`
// first CRUD round-trip
const check = await fetch(`${url}/api/data/entity/todos?limit=1`)
if (!check.ok) {
  console.error('bknd first CRUD failed', check.status)
  process.exit(1)
}
console.log(`READY ${url}`)

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
