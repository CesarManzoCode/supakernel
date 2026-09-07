import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createWebCryptoPort, generateSigningKey, systemClock, webRandom } from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import { openS3Blob } from '@supakernel/blob-s3'
import type { Family, PolicyRule, Principal } from '@supakernel/contracts'
import { sql } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import type { BlobAdapter, ClockPort, DatabaseAdapter } from '@supakernel/ports'
import { createStorageHandler, StorageService, storageSchemaStatements } from '../../src/index.js'
import { MemoryBlob } from './memory-blob.js'

export interface FakeClock extends ClockPort {
  advance(ms: number): void
}
export function fakeClock(): FakeClock {
  const base = systemClock()
  return { ...base, advance: () => {} }
}

const A: Principal = {
  kind: 'user',
  subjectId: 'user-a',
  tenantId: 'demo',
  role: 'authenticated',
  sessionId: 's',
  claims: { sub: 'user-a' },
  credentialSource: 'jwt',
}
const ANON: Principal = {
  kind: 'anonymous',
  subjectId: null,
  tenantId: 'demo',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none',
}
const SVC: Principal = {
  kind: 'service',
  subjectId: null,
  tenantId: 'demo',
  role: 'service_role',
  sessionId: null,
  claims: {},
  credentialSource: 'secret_key',
}
export const SEATS = { A, ANON, SVC }

export interface StorageHarness {
  service: StorageService
  blob: BlobAdapter
  adapter: DatabaseAdapter
  clock: FakeClock
  handler: (r: Request) => Promise<Response>
  client(seat?: keyof typeof SEATS): SupabaseClient
  cleanup(): Promise<void>
}

export async function makeStorageHarness(opts: {
  family: Family
  blob?: 'fs' | 'memory' | 's3' | BlobAdapter
  policies?: readonly PolicyRule[]
}): Promise<StorageHarness> {
  const adapter: DatabaseAdapter =
    opts.family === 'postgres'
      ? openPostgres({ url: process.env.SUPAKERNEL_TEST_PG_URL as string })
      : openNodeSqlite({ path: ':memory:' })
  for (const stmt of storageSchemaStatements(opts.family)) await adapter.execute(sql(stmt))

  const tmp = await mkdtemp(join(tmpdir(), 'sk-blob-'))
  const blob: BlobAdapter =
    typeof opts.blob === 'object'
      ? opts.blob
      : opts.blob === 'memory'
        ? new MemoryBlob()
        : opts.blob === 's3'
          ? openS3Blob({
              endpoint: process.env.SUPAKERNEL_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
              region: 'us-east-1',
              bucket: 'skblob',
              accessKeyId: process.env.SUPAKERNEL_TEST_S3_KEY ?? 'skminio',
              secretAccessKey: process.env.SUPAKERNEL_TEST_S3_SECRET ?? 'skminio123',
              forcePathStyle: true,
              id: `s3-${Date.now()}`,
            })
          : openFsBlob({ root: tmp })

  const key = await generateSigningKey('sk-storage-1')
  const crypto = await createWebCryptoPort([key])
  const clock = fakeClock()

  const service = new StorageService({
    adapter,
    blob,
    crypto,
    signingKeyId: key.kid,
    ports: { clock, random: webRandom() },
    projectRef: 'demo',
    ...(opts.policies ? { policies: opts.policies } : {}),
  })

  const seatFor = (s: keyof typeof SEATS): Principal => SEATS[s]
  const handler = createStorageHandler({
    service,
    resolvePrincipal: (headers) => {
      const key =
        headers.get('apikey') ?? headers.get('authorization')?.replace(/^Bearer /i, '') ?? 'A'
      return seatFor((['A', 'ANON', 'SVC'].includes(key) ? key : 'A') as keyof typeof SEATS)
    },
  })

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(new Request(url, init))
  }

  return {
    service,
    blob,
    adapter,
    clock,
    handler,
    client: (seat = 'A') =>
      createClient('http://sk.test', seat, {
        auth: { persistSession: false },
        global: { fetch: fetchImpl as typeof fetch },
      }),
    cleanup: async () => {
      await adapter.close()
      await rm(tmp, { recursive: true, force: true })
    },
  }
}
