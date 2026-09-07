import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeStorageHarness, SEATS, type StorageHarness } from './helpers/setup.js'

const FIX = new Uint8Array(123).map((_, i) => (i * 3 + 2) % 256)

describe('Storage — real @supabase/storage-js (contract §14, §30 L7)', () => {
  let h: StorageHarness
  beforeEach(async () => {
    h = await makeStorageHarness({ family: 'sqlite', blob: 'fs' })
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('bucket lifecycle + object upload / download / list / remove', async () => {
    const c = h.client('A')
    expect((await c.storage.createBucket('media')).error).toBeNull()
    expect((await c.storage.getBucket('media')).data?.name).toBe('media')

    const up = await c.storage
      .from('media')
      .upload('a/photo.bin', FIX, { contentType: 'application/octet-stream' })
    expect(up.error).toBeNull()

    const dl = await c.storage.from('media').download('a/photo.bin')
    expect(dl.error).toBeNull()
    expect(new Uint8Array(await dl.data!.arrayBuffer())).toEqual(FIX)

    const list = await c.storage.from('media').list('a')
    expect(list.data?.map((x) => x.name)).toContain('photo.bin')

    expect((await c.storage.from('media').remove(['a/photo.bin'])).error).toBeNull()
    const gone = await c.storage.from('media').download('a/photo.bin')
    expect(gone.error).not.toBeNull()
  })

  it('createSignedUrl returns a working URL — #64: field is `signedURL`, no /storage/v1 duplication', async () => {
    const c = h.client('A')
    await c.storage.createBucket('priv')
    await c.storage.from('priv').upload('doc.bin', FIX)

    const signed = await c.storage.from('priv').createSignedUrl('doc.bin', 3600)
    expect(signed.error).toBeNull()
    const url = signed.data!.signedUrl
    expect(url.match(/\/storage\/v1/g)).toHaveLength(1)

    const res = await h.handler(new Request(url))
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(123)
  })

  it('public bucket download works without a token', async () => {
    const c = h.client('A')
    await c.storage.createBucket('pub', { public: true })
    await c.storage.from('pub').upload('open.bin', FIX)
    const { data } = c.storage.from('pub').getPublicUrl('open.bin')
    const res = await h.handler(new Request(data.publicUrl))
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(123)
  })

  it('upsert replaces the object; move / copy work', async () => {
    const c = h.client('A')
    await c.storage.createBucket('w')
    await c.storage.from('w').upload('f.txt', new TextEncoder().encode('v1'))
    const re = await c.storage
      .from('w')
      .upload('f.txt', new TextEncoder().encode('v2'), { upsert: true })
    expect(re.error).toBeNull()
    const dl = await c.storage.from('w').download('f.txt')
    expect(await dl.data!.text()).toBe('v2')

    expect((await c.storage.from('w').copy('f.txt', 'g.txt')).error).toBeNull()
    expect((await c.storage.from('w').move('g.txt', 'h.txt')).error).toBeNull()
    expect(await (await c.storage.from('w').download('h.txt')).data!.text()).toBe('v2')
    expect((await c.storage.from('w').download('g.txt')).error).not.toBeNull()
  })
})
