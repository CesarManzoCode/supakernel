import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemClock, webRandom } from '@supakernel/auth'
import { openFsBlob } from '@supakernel/blob-fs'
import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { createMemoryMailSink } from '@supakernel/ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '../src/index.js'
import { makeKernel, POLICIES, SCHEMA } from './helpers/fixture.js'

describe('kernel lifecycle & composition (contract §6.3, §30 L9)', () => {
  let fx: Awaited<ReturnType<typeof makeKernel>>
  beforeEach(async () => {
    fx = await makeKernel()
  })
  afterEach(async () => {
    await fx.cleanup()
  })

  it('composes data + auth + storage + management; each responds', async () => {
    const { kernel } = fx
    const settings = await kernel.auth(new Request('http://k/auth/v1/settings'))
    expect(settings.status).toBe(200)

    const up = await kernel.auth(
      new Request('http://k/auth/v1/signup', {
        method: 'POST',
        headers: {
          apikey: kernel.authService.apiKeys.publishable,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@example.com', password: 'password123' }),
      }),
    )
    const session = await up.json()
    const bearer = {
      apikey: kernel.authService.apiKeys.publishable,
      authorization: `Bearer ${session.access_token}`,
    }

    const ins = await kernel.data(
      new Request('http://k/rest/v1/notes', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json', prefer: 'return=representation' },
        body: JSON.stringify({ tenant_id: 't', owner_id: session.user.id, title: 'hi' }),
      }),
    )
    expect(ins.status).toBe(201)

    const health = await kernel.management(new Request('http://k/_system/health'))
    expect((await health.json()).healthy).toBe(true)
  })

  it('dispose() stops accepting work (503) and closes adapters deterministically', async () => {
    const { kernel } = fx
    expect(kernel.isDisposed).toBe(false)
    await kernel.dispose()
    expect(kernel.isDisposed).toBe(true)
    const res = await kernel.data(new Request('http://k/rest/v1/notes'))
    expect(res.status).toBe(503)
    await expect(kernel.authService.db.adapter.execute(sql('SELECT 1'))).rejects.toThrow()
    await kernel.dispose() // idempotent
  })

  it('ProjectRegistry: register / get / restart / disposeAll', async () => {
    const registry = new ProjectRegistry()
    const mk = async (ref: string) => {
      const adapter = openNodeSqlite({ path: ':memory:' })
      await adapter.execute(
        sql(
          'CREATE TABLE notes (id TEXT PRIMARY KEY, tenant_id TEXT, owner_id TEXT, title TEXT, body TEXT, created_at SK_TEXT_TSTZ)',
        ),
      )
      const tmp = await mkdtemp(join(tmpdir(), 'sk-reg-'))
      return {
        projectRef: ref,
        serverSecret: 's',
        runtime: 'node' as const,
        adapter,
        blob: openFsBlob({ root: tmp }),
        schema: { ...SCHEMA, policies: POLICIES },
        policies: POLICIES,
        ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
        _tmp: tmp,
      }
    }
    const c1 = await mk('p1')
    await registry.register(c1)
    await registry.register(await mk('p2'))
    expect(registry.list()).toHaveLength(2)
    await expect(registry.register(c1)).rejects.toThrow(/DUPLICATE/)

    // restart = unregister + register a fresh instance
    await registry.unregister('p1')
    expect(registry.get('p1')).toBeUndefined()
    await registry.register(await mk('p1'))
    expect(registry.get('p1')?.isDisposed).toBe(false)

    await registry.disposeAll()
    expect(registry.list()).toHaveLength(0)
    await rm(c1._tmp, { recursive: true, force: true })
  })

  it('capabilities endpoint reports the effective matrix; core hash present', async () => {
    const res = await fx.kernel.management(
      new Request('http://k/.well-known/supakernel-capabilities'),
    )
    const caps = await res.json()
    expect(caps.services.data).toBe(true)
    expect(caps.services.management).toBe('read-only-plus-loopback-sql')
    expect(caps.core_hash).toBeTruthy()
    expect(caps.exclusions).toContain('rpc')
  })
})
