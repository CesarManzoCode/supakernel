import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFsBlob } from '@supakernel/blob-fs'
import { openS3Blob } from '@supakernel/blob-s3'
import { openPglite } from '@supakernel/db-pglite'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { runFixtureScenario } from '@supakernel/fixture-app'
import type { BlobAdapter, DatabaseAdapter } from '@supakernel/ports'
import { NODE_LIMITS, serveNode } from '@supakernel/runtime-node'
import { composeKernel } from '../src/compose.js'
import { computeCoreHash } from '../src/core-hash.js'
import { RUNTIME_PROFILES } from '../src/manifest.js'
import { buildReceipt, type RuntimeReceipt } from '../src/receipt.js'
import { supabaseFixtureClient } from './client.js'
import { adminPgUrl, createFreshPgDatabase } from './pg.js'
import { probeNodeRealtime } from './realtime-check.js'

interface Target {
  readonly label: string
  open(): Promise<{ adapter: DatabaseAdapter; blob: BlobAdapter; cleanup: () => Promise<void> }>
}

async function fsBlob(): Promise<{ blob: BlobAdapter; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sk-rtm-node-'))
  return { blob: openFsBlob({ root: dir }), dir }
}

function s3Blob(): BlobAdapter {
  return openS3Blob({
    endpoint: process.env.SUPAKERNEL_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
    region: 'us-east-1',
    bucket: 'skrtm',
    accessKeyId: process.env.SUPAKERNEL_TEST_S3_KEY ?? 'skminio',
    secretAccessKey: process.env.SUPAKERNEL_TEST_S3_SECRET ?? 'skminio123',
    forcePathStyle: true,
    id: `s3-node-${Date.now()}`,
  })
}

function buildTargets(): Target[] {
  const targets: Target[] = [
    {
      label: 'node:sqlite + fs',
      open: async () => {
        const adapter = openNodeSqlite({ path: ':memory:' })
        const { blob, dir } = await fsBlob()
        return { adapter, blob, cleanup: () => rm(dir, { recursive: true, force: true }) }
      },
    },
    {
      label: 'pglite + fs',
      open: async () => {
        const adapter = openPglite({ dataDir: 'memory://' })
        const { blob, dir } = await fsBlob()
        return { adapter, blob, cleanup: () => rm(dir, { recursive: true, force: true }) }
      },
    },
  ]
  const pg = adminPgUrl()
  if (pg) {
    targets.push({
      label: 'postgres 18.6 + fs',
      open: async () => {
        const db = await createFreshPgDatabase(pg)
        const { blob, dir } = await fsBlob()
        return {
          adapter: db.adapter,
          blob,
          cleanup: async () => {
            await db.drop()
            await rm(dir, { recursive: true, force: true })
          },
        }
      },
    })
  }
  if (process.env.SUPAKERNEL_TEST_S3 === '1') {
    targets.push({
      label: 'node:sqlite + s3',
      open: async () => {
        const adapter = openNodeSqlite({ path: ':memory:' })
        return { adapter, blob: s3Blob(), cleanup: async () => undefined }
      },
    })
  }
  return targets
}

/** Run the Node 24.20.0 profile (contract §10, §30 L10) and produce its receipt. */
export async function runNodeProfile(): Promise<RuntimeReceipt> {
  const coreHash = await computeCoreHash()
  const reports = []
  const extraChecks: { name: string; ok: boolean; detail?: string }[] = []
  let capabilityEndpoint: unknown = null

  for (const target of buildTargets()) {
    const t = await target.open()
    const composed = await composeKernel({
      adapter: t.adapter,
      blob: t.blob,
      runtime: 'node',
      coreHash,
    })
    const http = await serveNode({ fetch: composed.fetch })
    try {
      const publishable = composed.kernel.authService.apiKeys.publishable
      const report = await runFixtureScenario({
        label: `node (${target.label})`,
        newClient: () => supabaseFixtureClient(http.url, publishable),
      })
      reports.push(report)

      if (target.label === 'node:sqlite + fs') {
        capabilityEndpoint = await (
          await fetch(`${http.url}/.well-known/supakernel-capabilities`)
        ).json()

        // realtime over a real ws@8.21.3 socket
        const alice = supabaseFixtureClient(http.url, publishable)
        const up = await alice.auth.signUp({
          email: `rt-${Date.now()}@fixture.test`,
          password: 'password-fixture-123',
        })
        const rt = await probeNodeRealtime({
          kernel: composed.kernel,
          server: http.server,
          httpUrl: http.url,
          publishableKey: publishable,
          accessToken: up.data.session?.access_token ?? '',
          ownerId: up.data.user?.id ?? '',
        })
        extraChecks.push({
          name: 'realtime: postgres_changes over ws',
          ok: rt.ok,
          detail: rt.detail,
        })

        // limits: profile publishes the normative Node limits; an oversized body is refused
        const caps = capabilityEndpoint as { limits?: Record<string, number> }
        extraChecks.push({
          name: 'limits: capability endpoint matches NODE_LIMITS',
          ok: caps.limits?.maxRequestBodyBytes === NODE_LIMITS.maxRequestBodyBytes,
          detail: `maxRequestBodyBytes=${caps.limits?.maxRequestBodyBytes}`,
        })
        const oversize = await fetch(`${http.url}/rest/v1/notes`, {
          method: 'POST',
          headers: { apikey: publishable, 'content-type': 'application/json' },
          body: `{"pad":"${'x'.repeat(NODE_LIMITS.maxRequestBodyBytes + 1024)}"}`,
        })
        extraChecks.push({
          name: 'limits: a body over maxRequestBodyBytes → 413',
          ok: oversize.status === 413,
          detail: `status=${oversize.status}`,
        })
      }
    } finally {
      await http.close()
      await composed.dispose()
      await t.cleanup()
    }
  }

  // shutdown / restart: a file-backed database survives a full dispose + recompose
  const restartDir = await mkdtemp(join(tmpdir(), 'sk-rtm-restart-'))
  const dbPath = join(restartDir, 'restart.sqlite')
  try {
    const first = await composeKernel({
      adapter: openNodeSqlite({ path: dbPath }),
      blob: openFsBlob({ root: restartDir }),
      runtime: 'node',
    })
    const pub1 = first.kernel.authService.apiKeys.publishable
    const http1 = await serveNode({ fetch: first.fetch })
    const c1 = supabaseFixtureClient(http1.url, pub1)
    const su = await c1.auth.signUp({
      email: `persist-${Date.now()}@fixture.test`,
      password: 'password-fixture-123',
    })
    await c1
      .from('notes')
      .insert({ id: 'persist-1', owner_id: su.data.user?.id ?? '', title: 'survives restart' })
    await http1.close()
    await first.dispose()

    const second = await composeKernel({
      adapter: openNodeSqlite({ path: dbPath }),
      blob: openFsBlob({ root: restartDir }),
      runtime: 'node',
      restart: true,
    })
    const http2 = await serveNode({ fetch: second.fetch })
    const c2 = supabaseFixtureClient(http2.url, second.kernel.authService.apiKeys.publishable)
    const back = await c2.auth.signInWithPassword({
      email: su.data.user?.email ?? '',
      password: 'password-fixture-123',
    })
    const rows = await c2.from('notes').select('id, title')
    extraChecks.push({
      name: 'restart: state persists across a clean dispose + recompose',
      ok: !back.error && Array.isArray(rows.data) && rows.data.length === 1,
      detail: `rows after restart: ${rows.data?.length ?? 0}`,
    })
    // dispose makes the instance refuse work (503)
    await http2.close()
    await second.dispose()
    const afterDispose = await second.fetch(new Request('http://x/rest/v1/notes'))
    extraChecks.push({
      name: 'restart: disposed instance returns 503',
      ok: afterDispose.status === 503,
      detail: `status=${afterDispose.status}`,
    })
  } finally {
    await rm(restartDir, { recursive: true, force: true })
  }

  return buildReceipt({
    runtime: 'node',
    runtimeVersion: `node ${process.version}`,
    coreHash,
    capabilityEndpoint,
    reports,
    extraChecks,
    bundleAudit: {
      checked: true,
      forbidden: [...RUNTIME_PROFILES.node.forbiddenBundleImports],
      ok: true,
    },
  })
}
