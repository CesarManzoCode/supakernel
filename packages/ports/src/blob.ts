/**
 * Blob storage port (contract §8, §14). Bytes are untrusted until hash + size are verified;
 * only metadata in the `ready` state governs visibility.
 */
export interface BlobExpectation {
  readonly maxBytes: number
  readonly contentType: string | null
  /** When known ahead of time, the adapter must reject a mismatch. */
  readonly sha256?: string
}

export interface StagedBlob {
  readonly opId: string
  readonly stagedKey: string
  readonly bytes: number
  readonly sha256: string
}

export interface ByteRange {
  readonly start: number
  /** Inclusive end, or null for "to end of object". */
  readonly end: number | null
}

export interface BlobRead {
  readonly stream: ReadableStream<Uint8Array>
  readonly totalBytes: number
  readonly range: { readonly start: number; readonly end: number } | null
  readonly sha256: string
  readonly contentType: string | null
}

export interface BlobStat {
  readonly key: string
  readonly bytes: number
  readonly sha256: string
  readonly contentType: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BlobAdapter extends AsyncDisposable {
  readonly id: string
  putStaged(
    opId: string,
    body: ReadableStream<Uint8Array>,
    expected: BlobExpectation,
  ): Promise<StagedBlob>
  promote(staged: StagedBlob, finalKey: string): Promise<void>
  open(key: string, range?: ByteRange): Promise<BlobRead>
  stat(key: string): Promise<BlobStat | null>
  delete(key: string): Promise<void>
  listStaged(olderThan: string): AsyncIterable<StagedBlob>
}
