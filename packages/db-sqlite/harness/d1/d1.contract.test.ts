/**
 * First-party D1 conformance harness (contract §30 L2). Spawns `wrangler dev` — real
 * workerd, real local D1, compatibility date 2026-09-01 — and drives the shared connection
 * contract suite against the SqliteAdapter running inside the Worker.
 *
 *   pnpm test:db:workers
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DatabaseCapabilities,
  DbResult,
  DbRow,
  ObservedSchema,
  SqlStatement,
  SqlValue,
  Transaction,
  TransactionOptions,
} from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { runDatabaseContractSuite, vitestApi } from '@supakernel/ports-test'
import { afterAll, beforeAll } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 8811
const BASE = `http://127.0.0.1:${PORT}`
const wranglerBin = join(
  here,
  '../../../../node_modules/.pnpm/wrangler@4.129.0/node_modules/wrangler/bin/wrangler.js',
)

let proc: ChildProcess | undefined

type Wire =
  | { $: 'bytes'; b: number[] }
  | { $: 'bigint'; v: string }
  | null
  | boolean
  | number
  | string

function encode(v: SqlValue): Wire {
  if (v instanceof Uint8Array) return { $: 'bytes', b: [...v] }
  if (typeof v === 'bigint') return { $: 'bigint', v: v.toString() }
  return v
}
function decode(v: Wire): SqlValue {
  if (v !== null && typeof v === 'object') {
    if (v.$ === 'bytes') return new Uint8Array(v.b)
    if (v.$ === 'bigint') return BigInt(v.v)
  }
  return v as SqlValue
}
function decodeRow(row: Record<string, Wire>): DbRow {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = decode(v)
  return out as DbRow
}

async function rpc(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok || json.error) {
    const err = new Error(String(json.message ?? `HTTP ${res.status}`))
    if (json.kernelError) (err as Error & { kernelError: unknown }).kernelError = json.kernelError
    throw err
  }
  return json
}

class RemoteD1Adapter implements DatabaseAdapter {
  readonly id = 'sqlite-d1'
  readonly runtime = 'workers' as const
  readonly capabilities: DatabaseCapabilities = {
    family: 'sqlite',
    transactions: 'atomic-batch',
    ddlAtomicity: 'step-journal',
    nativeRls: false,
    returning: true,
    json: 'json-text',
    changeCapture: 'managed-triggers',
    isolation: ['serializable'],
  }

  async execute(statement: SqlStatement, _tx?: Transaction): Promise<DbResult> {
    const r = (await rpc('/execute', {
      text: statement.text,
      parameters: statement.parameters.map(encode),
    })) as { rows: Record<string, Wire>[]; rowCount: number }
    return { rows: r.rows.map(decodeRow), rowCount: r.rowCount }
  }

  transaction<T>(_options: TransactionOptions, _fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return Promise.reject(
      new Error('SK_CAPABILITY: D1 has no interactive transaction; use atomicBatch'),
    )
  }

  async atomicBatch(statements: readonly SqlStatement[]): Promise<readonly DbResult[]> {
    const r = (await rpc('/batch', {
      statements: statements.map((s) => ({ text: s.text, parameters: s.parameters.map(encode) })),
    })) as { results: { rowCount: number }[] }
    return r.results.map((x) => ({ rows: [], rowCount: x.rowCount }))
  }

  async introspect(): Promise<ObservedSchema> {
    return (await rpc('/introspect', {})) as ObservedSchema
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

async function waitReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'SELECT 1 AS one', parameters: [] }),
      })
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('wrangler dev did not become ready in time')
}

beforeAll(async () => {
  rmSync(join(here, '.wrangler-state'), { recursive: true, force: true })
  proc = spawn(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      join(here, '.wrangler-state'),
    ],
    {
      cwd: here,
      stdio: 'pipe',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    },
  )
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  await waitReady(60_000)
}, 90_000)

afterAll(async () => {
  proc?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  proc?.kill('SIGKILL')
  rmSync(join(here, '.wrangler-state'), { recursive: true, force: true })
})

runDatabaseContractSuite(vitestApi(), {
  label: 'Cloudflare D1 (real workerd, local D1)',
  open: async () => new RemoteD1Adapter(),
  reopen: async () => new RemoteD1Adapter(),
  cleanup: async () => {
    await rpc('/reset', {})
  },
})
