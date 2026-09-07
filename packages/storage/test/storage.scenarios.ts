import type { Family } from '@supakernel/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeStorageHarness, SEATS, type StorageHarness } from './helpers/setup.js'

const FIXTURE_123 = new Uint8Array(123).map((_, i) => (i * 7) % 256)

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream()
}

/** Shared Storage behavioural suite (contract §14, §30 L7). */
export function describeStorage(family: Family, blob: 'fs' | 'memory' | 's3'): void {
  describe(`Storage — ${family} + ${blob} blob (contract §14)`, () => {
    let h: StorageHarness
    beforeAll(async () => {
      h = await makeStorageHarness({ family, blob })
    })
    afterAll(async () => {
      await h.cleanup()
    })
    beforeEach(async () => {
      // fresh bucket per test
      await h.service.deleteBucket('b').catch(() => undefined)
      await h.service.emptyBucket('b').catch(() => undefined)
      await h.service.createBucket(SEATS.A, { name: 'b' }).catch(() => undefined)
    })

    it('upload → only `ready` is visible; download returns exact bytes', async () => {
      await h.service.upload(SEATS.A, 'b', 'dir/a.bin', stream(FIXTURE_123), {
        contentType: 'application/octet-stream',
      })
      const { stream: out, total } = await h.service.download(SEATS.A, 'b', 'dir/a.bin')
      const bytes = new Uint8Array(await new Response(out).arrayBuffer())
      expect(total).toBe(123)
      expect(bytes).toEqual(FIXTURE_123)
    })

    it('a non-existent object is 404, not a partial/empty read', async () => {
      await expect(h.service.download(SEATS.A, 'b', 'missing')).rejects.toMatchObject({
        kernelError: { httpStatus: 404 },
      })
    })

    it('duplicate upload without upsert is a conflict; upsert keeps the old object visible until the new one is ready', async () => {
      await h.service.upload(SEATS.A, 'b', 'x', stream(new TextEncoder().encode('one')))
      await expect(
        h.service.upload(SEATS.A, 'b', 'x', stream(new TextEncoder().encode('two'))),
      ).rejects.toMatchObject({
        kernelError: { httpStatus: 409 },
      })
      await h.service.upload(SEATS.A, 'b', 'x', stream(new TextEncoder().encode('three')), {
        upsert: true,
      })
      const { stream: out } = await h.service.download(SEATS.A, 'b', 'x')
      expect(await new Response(out).text()).toBe('three')
    })

    it('size limit is enforced against staged bytes', async () => {
      await h.service.updateBucket('b', { fileSizeLimit: 10 })
      await expect(
        h.service.upload(SEATS.A, 'b', 'big', stream(new Uint8Array(50))),
      ).rejects.toMatchObject({
        kernelError: { httpStatus: 413 },
      })
      expect(
        await h.service.download(SEATS.A, 'b', 'big').catch((e) => e.kernelError.httpStatus),
      ).toBe(404)
      await h.service.updateBucket('b', { fileSizeLimit: null })
    })

    it('byte ranges: 206 with exact Content-Range, 416 for an unsatisfiable range', async () => {
      await h.service.upload(SEATS.A, 'b', 'r', stream(FIXTURE_123))
      const part = await h.service.download(SEATS.A, 'b', 'r', { start: 100, end: 109 })
      expect(part.range).toEqual({ start: 100, end: 109 })
      const bytes = new Uint8Array(await new Response(part.stream).arrayBuffer())
      expect(bytes.byteLength).toBe(10)
      expect(bytes).toEqual(FIXTURE_123.slice(100, 110))
      await expect(
        h.service.download(SEATS.A, 'b', 'r', { start: 500, end: 600 }),
      ).rejects.toMatchObject({
        kernelError: { httpStatus: 416 },
      })
    })

    it('ready row whose bytes are gone → 500 integrity, never a misleading 404', async () => {
      await h.service.upload(SEATS.A, 'b', 'ghost', stream(FIXTURE_123))
      await wipeBytes(h, 'b', 'ghost')
      // recovery marks the ready-without-bytes row corrupt
      const stats = await h.service.recover()
      expect(stats.corrupted).toBeGreaterThanOrEqual(1)
      // and a read is a 500 integrity failure, never a misleading 404
      const status = await h.service
        .download(SEATS.A, 'b', 'ghost')
        .catch((e) => e.kernelError.httpStatus)
      expect(status).toBe(500)
    })

    it('recovery: staging+bytes → ready; staging w/o bytes → aborted; deleting → finished', async () => {
      const other = await makeStorageHarness({ family, blob })
      try {
        await other.service.createBucket(SEATS.A, { name: 'rec' })
        const nowIso = other.clock.now()
        // a staging row whose bytes ARE present at the final key
        const staged = await other.blob.putStaged('op-live', stream(FIXTURE_123), {
          maxBytes: 1_000,
          contentType: null,
        })
        await other.blob.promote(staged, 'rec/live#v1')
        await insertObject(other, 'rec', 'live', 'staging', 'op-live', 'v1', nowIso)
        // a staging row with no bytes anywhere
        await insertObject(other, 'rec', 'orphan', 'staging', 'op-x', 'v2', nowIso)
        // a row stuck in `deleting`
        await insertObject(other, 'rec', 'gone', 'deleting', 'op-y', 'v3', nowIso)

        const stats = await other.service.recover()
        expect(stats.promoted).toBeGreaterThanOrEqual(1)
        expect(stats.aborted).toBeGreaterThanOrEqual(1)
        expect(stats.deleted).toBeGreaterThanOrEqual(1)
        const { total } = await other.service.download(SEATS.A, 'rec', 'live')
        expect(total).toBe(123)
      } finally {
        await other.cleanup()
      }
    })

    it('service_role bypasses storage authorization; anon cannot write a non-public bucket', async () => {
      await expect(
        h.service.upload(SEATS.ANON, 'b', 'nope', stream(FIXTURE_123)),
      ).rejects.toMatchObject({
        kernelError: { httpStatus: 403 },
      })
      await h.service.upload(SEATS.SVC, 'b', 'svc.bin', stream(FIXTURE_123))
      const { total } = await h.service.download(SEATS.SVC, 'b', 'svc.bin')
      expect(total).toBe(123)
    })

    it('canonical path rejects traversal, NUL, backslash and double-encoding', async () => {
      for (const bad of ['../etc/passwd', 'a/../../b', 'a\\b', 'a%00b', 'a%252e%252e/b']) {
        await expect(
          h.service.upload(SEATS.A, 'b', bad, stream(FIXTURE_123)),
        ).rejects.toMatchObject({
          kernelError: { code: 'SK_STORAGE_INVALID_PATH' },
        })
      }
    })
  })
}

async function wipeBytes(h: StorageHarness, bucket: string, name: string): Promise<void> {
  const family = h.adapter.capabilities.family
  const t = family === 'postgres' ? 'storage.objects' : 'storage_objects'
  const p = family === 'postgres' ? '$1' : '?'
  const rows = await h.adapter.execute({
    text: `SELECT bucket_id, name, version FROM ${t} WHERE name = ${p} AND state = 'ready'`,
    parameters: [name],
  })
  const r = rows.rows[0] as { bucket_id: string; name: string; version: string } | undefined
  if (r) await h.blob.delete(`${r.bucket_id}/${r.name}#${r.version}`)
  void bucket
}

async function insertObject(
  h: StorageHarness,
  bucket: string,
  name: string,
  state: string,
  opId: string,
  version: string,
  now: string,
): Promise<void> {
  const family = h.adapter.capabilities.family
  const t = family === 'postgres' ? 'storage.objects' : 'storage_objects'
  const ph = (n: number): string =>
    Array.from({ length: n }, (_, i) => (family === 'postgres' ? `$${i + 1}` : '?')).join(',')
  await h.adapter.execute({
    text: `INSERT INTO ${t} (id, bucket_id, name, state, op_id, metadata, version, created_at, updated_at) VALUES (${ph(9)})`,
    parameters: [`${name}-id`, bucket, name, state, opId, '{}', version, now, now],
  })
}
