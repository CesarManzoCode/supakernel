import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FsBlobAdapter, openFsBlob } from '../src/index.js'

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream()
}

describe('FsBlobAdapter (contract §14)', () => {
  let root: string
  let blob: FsBlobAdapter
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sk-fsblob-'))
    blob = openFsBlob({ root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const FIX = new Uint8Array(123).map((_, i) => (i * 5 + 3) % 256)

  it('staged bytes are not readable until promoted; promote is idempotent', async () => {
    const staged = await blob.putStaged('op1', stream(FIX), { maxBytes: 1024, contentType: null })
    expect(staged.bytes).toBe(123)
    expect(await blob.stat('bkt/file')).toBeNull()
    await blob.promote(staged, 'bkt/file')
    await blob.promote(staged, 'bkt/file') // idempotent replay
    const read = await blob.open('bkt/file')
    expect(new Uint8Array(await new Response(read.stream).arrayBuffer())).toEqual(FIX)
    expect((await blob.stat('bkt/file'))?.bytes).toBe(123)
    expect((await blob.stat('bkt/file'))?.sha256).toBe(staged.sha256)
  })

  it('enforces maxBytes and expected sha256', async () => {
    await expect(
      blob.putStaged('op2', stream(new Uint8Array(50)), { maxBytes: 10, contentType: null }),
    ).rejects.toThrow(/TOO_LARGE/)
    await expect(
      blob.putStaged('op3', stream(new Uint8Array(5)), {
        maxBytes: 100,
        contentType: null,
        sha256: 'nope',
      }),
    ).rejects.toThrow(/HASH_MISMATCH/)
  })

  it('range reads: exact slice and 416 for an unsatisfiable range', async () => {
    const staged = await blob.putStaged('op4', stream(FIX), { maxBytes: 1024, contentType: null })
    await blob.promote(staged, 'k')
    const part = await blob.open('k', { start: 100, end: 122 })
    expect(new Uint8Array(await new Response(part.stream).arrayBuffer())).toEqual(
      FIX.slice(100, 123),
    )
    await expect(blob.open('k', { start: 200, end: 300 })).rejects.toThrow(/RANGE_NOT_SATISFIABLE/)
  })

  it('a promoted-then-missing file is an integrity failure, not a silent empty read', async () => {
    const staged = await blob.putStaged('op5', stream(FIX), { maxBytes: 1024, contentType: null })
    await blob.promote(staged, 'gone')
    await blob.delete('gone')
    await expect(blob.open('gone')).rejects.toThrow(/OBJECT_MISSING/)
  })

  it('listStaged surfaces orphan staged blobs older than a cutoff', async () => {
    await blob.putStaged('orphan', stream(FIX), { maxBytes: 1024, contentType: null })
    const future = new Date(Date.now() + 60_000).toISOString()
    const seen: string[] = []
    for await (const s of blob.listStaged(future)) seen.push(s.opId)
    expect(seen).toContain('orphan')
  })
})
