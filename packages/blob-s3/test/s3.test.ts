import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openS3Blob, type S3BlobAdapter } from '../src/index.js'

const ENDPOINT = process.env.SUPAKERNEL_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000'
const HAVE = process.env.SUPAKERNEL_TEST_S3 === '1'
const d = HAVE ? describe : describe.skip

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream()
}

d('S3 BlobAdapter against a real S3-compatible store (contract §14)', () => {
  let blob: S3BlobAdapter
  beforeAll(() => {
    blob = openS3Blob({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      bucket: 'skblob',
      accessKeyId: process.env.SUPAKERNEL_TEST_S3_KEY ?? 'skminio',
      secretAccessKey: process.env.SUPAKERNEL_TEST_S3_SECRET ?? 'skminio123',
      forcePathStyle: true,
    })
  })
  afterAll(async () => {
    await blob[Symbol.asyncDispose]()
  })

  it('putStaged → promote → open round-trips exact bytes and hash', async () => {
    const bytes = new Uint8Array(123).map((_, i) => (i * 7) % 256)
    const staged = await blob.putStaged(`op-${Date.now()}`, stream(bytes), {
      maxBytes: 1024,
      contentType: 'application/octet-stream',
    })
    expect(staged.bytes).toBe(123)
    const finalKey = `objects/roundtrip-${Date.now()}`
    await blob.promote(staged, finalKey)
    const read = await blob.open(finalKey)
    const got = new Uint8Array(await new Response(read.stream).arrayBuffer())
    expect(got).toEqual(bytes)
    expect(read.totalBytes).toBe(123)
    await blob.delete(finalKey)
    expect(await blob.stat(finalKey)).toBeNull()
  })

  it('enforces the size limit on staged bytes', async () => {
    await expect(
      blob.putStaged(`op-big-${Date.now()}`, stream(new Uint8Array(200)), {
        maxBytes: 10,
        contentType: null,
      }),
    ).rejects.toThrow()
  })

  it('rejects a known hash mismatch', async () => {
    await expect(
      blob.putStaged(`op-h-${Date.now()}`, stream(new Uint8Array(5)), {
        maxBytes: 100,
        contentType: null,
        sha256: 'deadbeef',
      }),
    ).rejects.toThrow()
  })

  it('range reads return the exact slice', async () => {
    const bytes = new Uint8Array(100).map((_, i) => i)
    const staged = await blob.putStaged(`op-r-${Date.now()}`, stream(bytes), {
      maxBytes: 1024,
      contentType: null,
    })
    const key = `objects/range-${Date.now()}`
    await blob.promote(staged, key)
    const read = await blob.open(key, { start: 10, end: 19 })
    const got = new Uint8Array(await new Response(read.stream).arrayBuffer())
    expect(got).toEqual(bytes.slice(10, 20))
    await blob.delete(key)
  })
})
