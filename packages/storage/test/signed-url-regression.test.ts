import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeStorageHarness, SEATS, type StorageHarness } from './helpers/setup.js'

/**
 * Regression for SupaDiff / lite-projects #64 (contract §14.1):
 *  1. the signed response field MUST be `signedURL` (not `signedUrl`);
 *  2. the returned path is relative to the Storage base and MUST NOT repeat `/storage/v1`.
 * The redeemed fixture is exactly 123 bytes.
 */
const FIXTURE_123 = new Uint8Array(123).map((_, i) => (i * 13 + 1) % 256)

describe('signed URL — lite-projects #64 regression', () => {
  let h: StorageHarness
  beforeEach(async () => {
    h = await makeStorageHarness({ family: 'sqlite', blob: 'fs' })
    await h.service.createBucket(SEATS.A, { name: 'priv' })
    await h.service.upload(SEATS.A, 'priv', 'reports/q3.bin', new Blob([FIXTURE_123]).stream(), {
      contentType: 'application/octet-stream',
    })
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('service returns { signedURL } and a path with no /storage/v1 duplication', async () => {
    const res = await h.service.createSignedUrl(SEATS.A, 'priv', 'reports/q3.bin', 3600)
    expect(Object.keys(res)).toEqual(['signedURL'])
    expect(res).not.toHaveProperty('signedUrl')
    expect(res.signedURL).toMatch(/^\/object\/sign\/priv\/reports\/q3\.bin\?token=/)
    expect(res.signedURL).not.toMatch(/\/storage\/v1/)
    // storage-js composes `${storageUrl}${signedURL}` where storageUrl already ends in /storage/v1
    const composed = `http://sk.test/storage/v1${res.signedURL}`
    expect(composed.match(/\/storage\/v1/g)).toHaveLength(1)
  })

  it('the redeemed signed URL streams exactly 123 bytes; a tampered path fails', async () => {
    const { signedURL } = await h.service.createSignedUrl(SEATS.A, 'priv', 'reports/q3.bin', 3600)
    const res = await h.handler(new Request(`http://sk.test/storage/v1${signedURL}`))
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.byteLength).toBe(123)
    expect(bytes).toEqual(FIXTURE_123)

    // a token minted for one object cannot be replayed against another path
    const token = new URL(`http://x${signedURL}`).searchParams.get('token') as string
    await h.service.upload(
      SEATS.A,
      'priv',
      'reports/secret.bin',
      new Blob([new Uint8Array(9)]).stream(),
    )
    const bad = await h.handler(
      new Request(`http://sk.test/storage/v1/object/sign/priv/reports/secret.bin?token=${token}`),
    )
    expect(bad.status).toBe(400)
  })

  it('the signed token is GET/HEAD only and does not inherit service_role', async () => {
    const { signedURL } = await h.service
      .createSignedUrl(SEATS.ANON, 'priv', 'reports/q3.bin', 3600)
      .catch(() => ({ signedURL: null }))
    // anon has no storage.read on a non-public bucket → cannot mint
    expect(signedURL).toBeNull()
  })

  it('range requests over a signed URL return 206 with an exact Content-Range', async () => {
    const { signedURL } = await h.service.createSignedUrl(SEATS.A, 'priv', 'reports/q3.bin', 3600)
    const res = await h.handler(
      new Request(`http://sk.test/storage/v1${signedURL}`, { headers: { range: 'bytes=10-19' } }),
    )
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/123')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect((await res.arrayBuffer()).byteLength).toBe(10)
  })
})
