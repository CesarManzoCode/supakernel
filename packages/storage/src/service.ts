import {
  type Column,
  type Family,
  isPrivilegedService,
  type Json,
  type PolicyRule,
  type Principal,
  type SchemaIR,
} from '@supakernel/contracts'
import { buildSecurityPlan, checkRowAllowed } from '@supakernel/policy'
import type {
  BlobAdapter,
  ByteRange,
  ClockPort,
  CryptoPort,
  DatabaseAdapter,
  FaultPort,
  RandomPort,
} from '@supakernel/ports'
import { NULL_FAULT_PORT } from '@supakernel/ports'
import { canonicalPath, isValidBucketName } from './canonical.js'
import { StorageDb, storageTable } from './db.js'
import { STORAGE_ERRORS, StorageError } from './errors.js'
import { mintSignedToken, verifySignedToken } from './signed-url.js'

const DEFAULT_LIMIT = 50 * 1024 * 1024

export interface StoragePorts {
  readonly clock: ClockPort
  readonly random: RandomPort
  /** Fault-injection hook (contract §22). No-op in production. */
  readonly fault?: FaultPort
}

export interface StorageServiceOptions {
  readonly adapter: DatabaseAdapter
  readonly blob: BlobAdapter
  readonly crypto: CryptoPort
  readonly signingKeyId: string
  readonly ports: StoragePorts
  readonly projectRef: string
  /** Storage authorization policies (virtual resource `objects`, actions `storage.read/write`). */
  readonly policies?: readonly PolicyRule[]
}

export interface BucketInfo {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  created_at: string
  updated_at: string
}

export interface ObjectInfo {
  id: string
  bucket_id: string
  name: string
  size: number
  content_type: string | null
  cache_control: string | null
  metadata: Json
  created_at: string
  updated_at: string
}

const RESOURCE_COLUMNS: Column[] = [
  { name: 'bucket_id', type: 'text', nullable: false, default: null, generated: false },
  { name: 'name', type: 'text', nullable: false, default: null, generated: false },
  { name: 'owner', type: 'text', nullable: true, default: null, generated: false },
]

export class StorageService {
  readonly db: StorageDb
  private readonly blob: BlobAdapter
  private readonly crypto: CryptoPort
  private readonly signingKeyId: string
  private readonly ports: StoragePorts
  private readonly fault: FaultPort
  private readonly projectRef: string
  private readonly policySchema: SchemaIR

  constructor(o: StorageServiceOptions) {
    const family: Family = o.adapter.capabilities.family
    this.db = new StorageDb(o.adapter, family)
    this.blob = o.blob
    this.crypto = o.crypto
    this.signingKeyId = o.signingKeyId
    this.ports = o.ports
    this.fault = o.ports.fault ?? NULL_FAULT_PORT
    this.projectRef = o.projectRef
    this.policySchema = {
      version: 1,
      tables: [
        {
          name: 'objects',
          columns: RESOURCE_COLUMNS,
          primaryKey: ['bucket_id', 'name'],
          uniques: [],
          foreignKeys: [],
          checks: [],
          indexes: [],
        },
      ],
      sequences: [],
      policies: [...(o.policies ?? [])],
    }
  }

  private B(): string {
    return storageTable('buckets', this.db.family)
  }
  private O(): string {
    return storageTable('objects', this.db.family)
  }

  // ---- buckets ----

  async createBucket(
    principal: Principal,
    input: {
      name: string
      public?: boolean
      fileSizeLimit?: number | null
      allowedMimeTypes?: string[] | null
    },
  ): Promise<BucketInfo> {
    if (!isValidBucketName(input.name)) throw STORAGE_ERRORS.unsupported('invalid bucket name')
    if (await this.db.one(`SELECT id FROM ${this.B()} WHERE name = ?`, [input.name]))
      throw STORAGE_ERRORS.bucketExists()
    const now = this.ports.clock.now()
    const id = input.name
    await this.db.run(
      `INSERT INTO ${this.B()} (id, name, public, file_size_limit, allowed_mime_types, owner, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        input.name,
        this.bool(input.public ?? false),
        input.fileSizeLimit == null ? null : this.i64(input.fileSizeLimit),
        input.allowedMimeTypes ? JSON.stringify(input.allowedMimeTypes) : null,
        principal.subjectId,
        now,
        now,
      ],
    )
    return this.getBucket(input.name)
  }

  async getBucket(name: string): Promise<BucketInfo> {
    const row = await this.db.one(`SELECT * FROM ${this.B()} WHERE name = ?`, [name])
    if (!row) throw STORAGE_ERRORS.bucketNotFound()
    return this.bucketView(row)
  }

  async listBuckets(): Promise<BucketInfo[]> {
    const rows = await this.db.all(`SELECT * FROM ${this.B()} ORDER BY created_at`)
    return rows.map((r) => this.bucketView(r))
  }

  async updateBucket(
    name: string,
    patch: { public?: boolean; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
  ): Promise<BucketInfo> {
    const bucket = await this.getBucket(name)
    const now = this.ports.clock.now()
    await this.db.run(
      `UPDATE ${this.B()} SET public = ?, file_size_limit = ?, allowed_mime_types = ?, updated_at = ? WHERE name = ?`,
      [
        this.bool(patch.public ?? bucket.public),
        patch.fileSizeLimit === undefined
          ? bucket.file_size_limit == null
            ? null
            : this.i64(bucket.file_size_limit)
          : patch.fileSizeLimit == null
            ? null
            : this.i64(patch.fileSizeLimit),
        patch.allowedMimeTypes === undefined
          ? bucket.allowed_mime_types
            ? JSON.stringify(bucket.allowed_mime_types)
            : null
          : patch.allowedMimeTypes
            ? JSON.stringify(patch.allowedMimeTypes)
            : null,
        now,
        name,
      ],
    )
    return this.getBucket(name)
  }

  async emptyBucket(name: string): Promise<void> {
    const bucket = await this.getBucket(name)
    const rows = await this.db.all(
      `SELECT id, name, version FROM ${this.O()} WHERE bucket_id = ?`,
      [bucket.id],
    )
    for (const r of rows) {
      await this.blob
        .delete(this.finalKey(bucket.id, String(r.name), String(r.version)))
        .catch(() => undefined)
    }
    await this.db.run(`DELETE FROM ${this.O()} WHERE bucket_id = ?`, [bucket.id])
  }

  async deleteBucket(name: string): Promise<void> {
    const bucket = await this.getBucket(name)
    const rows = await this.db.all(
      `SELECT id FROM ${this.O()} WHERE bucket_id = ? AND state = 'ready'`,
      [bucket.id],
    )
    if (rows.length > 0) throw STORAGE_ERRORS.unsupported('bucket is not empty')
    await this.db.run(`DELETE FROM ${this.B()} WHERE name = ?`, [name])
  }

  // ---- objects: upload state machine (contract §14.2) ----

  async upload(
    principal: Principal,
    bucketName: string,
    rawPath: string,
    body: ReadableStream<Uint8Array>,
    opts: {
      contentType?: string | null
      cacheControl?: string | null
      upsert?: boolean
      expectedSha256?: string
    } = {},
  ): Promise<ObjectInfo> {
    const path = canonicalPath(rawPath)
    const bucket = await this.getBucket(bucketName)
    await this.authorize(principal, 'storage.write', {
      bucket_id: bucket.id,
      name: path,
      owner: principal.subjectId,
    })

    const prior = await this.currentReady(bucket.id, path)
    if (prior && !opts.upsert) throw STORAGE_ERRORS.objectExists()

    const opId = this.ports.random.uuidV4()
    const version = this.ports.random.uuidV4()
    const now = this.ports.clock.now()
    const id = this.ports.random.uuidV4()

    // 1. reserve staging metadata in a transaction
    await this.db.tx(async (tx) => {
      await this.db.run(
        `INSERT INTO ${this.O()} (id, bucket_id, name, state, op_id, content_type, cache_control, owner, metadata, version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          bucket.id,
          path,
          'staging',
          opId,
          opts.contentType ?? null,
          opts.cacheControl ?? null,
          principal.subjectId,
          '{}',
          version,
          now,
          now,
        ],
        tx,
      )
    })
    await this.fault.hit('storage.after_reserve', { id })

    // 2/3. write staged bytes; enforce size + hash
    const limit = bucket.file_size_limit ?? DEFAULT_LIMIT
    let staged: Awaited<ReturnType<BlobAdapter['putStaged']>>
    try {
      staged = await this.blob.putStaged(opId, body, {
        maxBytes: limit,
        contentType: opts.contentType ?? null,
        ...(opts.expectedSha256 ? { sha256: opts.expectedSha256 } : {}),
      })
    } catch (err) {
      await this.db.run(`DELETE FROM ${this.O()} WHERE id = ?`, [id])
      throw err
    }

    await this.fault.hit('storage.after_bytes', { id })

    // 4. promote to the final key idempotently
    await this.blob.promote(staged, this.finalKey(bucket.id, path, version))
    await this.fault.hit('storage.after_promote', { id })

    // 5. CAS staging → ready with size + hash; only `ready` is visible
    await this.fault.hit('storage.before_ready', { id })
    const cas = await this.db.run(
      `UPDATE ${this.O()} SET state = 'ready', size = ?, sha256 = ?, updated_at = ? WHERE id = ? AND state = 'staging'`,
      [this.i64(staged.bytes), staged.sha256, this.ports.clock.now(), id],
    )
    if (cas !== 1) {
      await this.blob.delete(this.finalKey(bucket.id, path, version)).catch(() => undefined)
      throw STORAGE_ERRORS.integrityFailure()
    }
    await this.fault.hit('storage.after_ready', { id })

    // 6. upsert: keep the previous object visible until now, then retire it
    if (prior) {
      await this.db.run(`UPDATE ${this.O()} SET state = 'deleting', updated_at = ? WHERE id = ?`, [
        now,
        prior.id,
      ])
      await this.blob.delete(this.finalKey(bucket.id, path, prior.version)).catch(() => undefined)
      await this.db.run(`DELETE FROM ${this.O()} WHERE id = ?`, [prior.id])
    }

    return this.objectInfo(await this.requireObject(bucket.id, path))
  }

  async download(
    principal: Principal,
    bucketName: string,
    rawPath: string,
    range?: ByteRange,
  ): Promise<{
    stream: ReadableStream<Uint8Array>
    info: ObjectInfo
    range: { start: number; end: number } | null
    total: number
  }> {
    const path = canonicalPath(rawPath)
    const bucket = await this.getBucket(bucketName)
    const obj = await this.currentReady(bucket.id, path)
    if (!obj) {
      // a non-ready row must not masquerade as 404 if bytes are actually missing (contract §14.2)
      const any = await this.db.one(
        `SELECT state FROM ${this.O()} WHERE bucket_id = ? AND name = ? ORDER BY created_at DESC`,
        [bucket.id, path],
      )
      if (any && any.state === 'corrupt') throw STORAGE_ERRORS.integrityFailure()
      throw STORAGE_ERRORS.objectNotFound()
    }
    if (!bucket.public) {
      await this.authorize(principal, 'storage.read', {
        bucket_id: bucket.id,
        name: path,
        owner: obj.owner,
      })
    }
    return this.serveBytes(bucket.id, obj, range)
  }

  private async serveBytes(
    bucketId: string,
    obj: {
      id: string
      name: string
      version: string
      owner: string | null
      size: number
      content_type: string | null
      cache_control: string | null
      created_at: string
      updated_at: string
    },
    range?: ByteRange,
  ): Promise<{
    stream: ReadableStream<Uint8Array>
    info: ObjectInfo
    range: { start: number; end: number } | null
    total: number
  }> {
    let read: Awaited<ReturnType<BlobAdapter['open']>>
    try {
      read = await this.blob.open(this.finalKey(bucketId, obj.name, obj.version), range)
    } catch (err) {
      if (err instanceof StorageError && err.kernelError.code === 'SK_STORAGE_RANGE') throw err
      const ke = (err as { kernelError?: { code?: string } }).kernelError
      if (ke?.code === 'SK_STORAGE_RANGE_NOT_SATISFIABLE')
        throw STORAGE_ERRORS.rangeNotSatisfiable(obj.size)
      // ready row but the bytes are gone → mark corrupt, 500 integrity (never a misleading 404)
      await this.db.run(`UPDATE ${this.O()} SET state = 'corrupt', updated_at = ? WHERE id = ?`, [
        this.ports.clock.now(),
        obj.id,
      ])
      throw STORAGE_ERRORS.integrityFailure()
    }
    return {
      stream: read.stream,
      info: this.objectInfo(obj),
      range: read.range,
      total: read.totalBytes || obj.size,
    }
  }

  async objectInfoFor(
    principal: Principal,
    bucketName: string,
    rawPath: string,
  ): Promise<ObjectInfo> {
    const path = canonicalPath(rawPath)
    const bucket = await this.getBucket(bucketName)
    const obj = await this.currentReady(bucket.id, path)
    if (!obj) throw STORAGE_ERRORS.objectNotFound()
    if (!bucket.public)
      await this.authorize(principal, 'storage.read', {
        bucket_id: bucket.id,
        name: path,
        owner: obj.owner,
      })
    return this.objectInfo(obj)
  }

  async list(
    principal: Principal,
    bucketName: string,
    prefix: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<
    Array<{ name: string; id: string; metadata: { size: number; mimetype: string | null } }>
  > {
    const bucket = await this.getBucket(bucketName)
    await this.authorize(principal, 'storage.read', {
      bucket_id: bucket.id,
      name: prefix,
      owner: principal.subjectId,
    })
    const like = `${prefix.replace(/[%_]/g, '\\$&')}%`
    const rows = await this.db.all(
      `SELECT id, name, size, content_type, owner FROM ${this.O()} WHERE bucket_id = ? AND state = 'ready' AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ? OFFSET ?`,
      [bucket.id, like, opts.limit ?? 100, opts.offset ?? 0],
    )
    const out: Array<{
      name: string
      id: string
      metadata: { size: number; mimetype: string | null }
    }> = []
    for (const r of rows) {
      if (!bucket.public) {
        try {
          await this.authorize(principal, 'storage.read', {
            bucket_id: bucket.id,
            name: String(r.name),
            owner: (r.owner as string) ?? null,
          })
        } catch {
          continue
        }
      }
      out.push({
        id: String(r.id),
        name: String(r.name).slice(prefix.length).replace(/^\//, ''),
        metadata: {
          size: Number(r.size ?? 0),
          mimetype: (r.content_type as string | null) ?? null,
        },
      })
    }
    return out
  }

  async remove(principal: Principal, bucketName: string, rawPath: string): Promise<void> {
    const path = canonicalPath(rawPath)
    const bucket = await this.getBucket(bucketName)
    const obj = await this.currentReady(bucket.id, path)
    if (!obj) throw STORAGE_ERRORS.objectNotFound()
    await this.authorize(principal, 'storage.write', {
      bucket_id: bucket.id,
      name: path,
      owner: obj.owner,
    })
    await this.db.run(`UPDATE ${this.O()} SET state = 'deleting', updated_at = ? WHERE id = ?`, [
      this.ports.clock.now(),
      obj.id,
    ])
    await this.fault.hit('storage.during_delete', { id: obj.id })
    await this.blob.delete(this.finalKey(bucket.id, path, obj.version)).catch(() => undefined)
    await this.db.run(`DELETE FROM ${this.O()} WHERE id = ?`, [obj.id])
  }

  async copy(
    principal: Principal,
    bucketName: string,
    from: string,
    to: string,
  ): Promise<ObjectInfo> {
    const bucket = await this.getBucket(bucketName)
    const src = await this.currentReady(bucket.id, canonicalPath(from))
    if (!src) throw STORAGE_ERRORS.objectNotFound()
    await this.authorize(principal, 'storage.read', {
      bucket_id: bucket.id,
      name: src.name,
      owner: src.owner,
    })
    const read = await this.blob.open(this.finalKey(bucket.id, src.name, src.version))
    return this.upload(principal, bucketName, to, read.stream, {
      contentType: src.content_type,
      cacheControl: src.cache_control,
      upsert: true,
    })
  }

  async move(principal: Principal, bucketName: string, from: string, to: string): Promise<void> {
    await this.copy(principal, bucketName, from, to)
    await this.remove(principal, bucketName, from)
  }

  // ---- signed URLs (contract §14.2) ----

  async createSignedUrl(
    principal: Principal,
    bucketName: string,
    rawPath: string,
    ttlSeconds: number,
  ): Promise<{ signedURL: string }> {
    const path = canonicalPath(rawPath)
    const bucket = await this.getBucket(bucketName)
    const obj = await this.currentReady(bucket.id, path)
    if (!obj) throw STORAGE_ERRORS.objectNotFound()
    await this.authorize(principal, 'storage.read', {
      bucket_id: bucket.id,
      name: path,
      owner: obj.owner,
    })
    const token = await mintSignedToken(this.crypto, this.signingKeyId, {
      project: this.projectRef,
      bucket: bucketName,
      path,
      ttlSeconds,
      nowMs: this.ports.clock.epochMillis(),
    })
    // path is relative to the Storage base and DOES NOT repeat `/storage/v1` (regression #64)
    return { signedURL: `/object/sign/${bucketName}/${path}?token=${token}` }
  }

  async createSignedUrls(
    principal: Principal,
    bucketName: string,
    paths: string[],
    ttlSeconds: number,
  ): Promise<Array<{ path: string; signedURL: string | null; error: string | null }>> {
    return Promise.all(
      paths.map(async (p) => {
        try {
          const { signedURL } = await this.createSignedUrl(principal, bucketName, p, ttlSeconds)
          return { path: p, signedURL, error: null }
        } catch (err) {
          return {
            path: p,
            signedURL: null,
            error: err instanceof StorageError ? err.kernelError.code : 'error',
          }
        }
      }),
    )
  }

  async downloadSigned(
    bucketName: string,
    rawPath: string,
    token: string,
    range?: ByteRange,
  ): Promise<{
    stream: ReadableStream<Uint8Array>
    info: ObjectInfo
    range: { start: number; end: number } | null
    total: number
  }> {
    const path = canonicalPath(rawPath)
    await verifySignedToken(this.crypto, token, {
      project: this.projectRef,
      bucket: bucketName,
      path,
      nowMs: this.ports.clock.epochMillis(),
    })
    const bucket = await this.getBucket(bucketName)
    const obj = await this.currentReady(bucket.id, path)
    if (!obj) throw STORAGE_ERRORS.objectNotFound()
    return this.serveBytes(bucket.id, obj, range)
  }

  async publicDownload(
    bucketName: string,
    rawPath: string,
    range?: ByteRange,
  ): Promise<{
    stream: ReadableStream<Uint8Array>
    info: ObjectInfo
    range: { start: number; end: number } | null
    total: number
  }> {
    const path = canonicalPath(rawPath)
    const bucket = await this.getBucket(bucketName)
    if (!bucket.public) throw STORAGE_ERRORS.notAuthorized()
    const obj = await this.currentReady(bucket.id, path)
    if (!obj) throw STORAGE_ERRORS.objectNotFound()
    return this.serveBytes(bucket.id, obj, range)
  }

  // ---- recovery (contract §14.2) ----

  async recover(
    staleBeforeIso?: string,
  ): Promise<{ promoted: number; aborted: number; corrupted: number; deleted: number }> {
    const stats = { promoted: 0, aborted: 0, corrupted: 0, deleted: 0 }
    const rows = await this.db.all(
      `SELECT * FROM ${this.O()} WHERE state IN ('staging','deleting','corrupt')`,
    )
    for (const r of rows) {
      const bucketId = String(r.bucket_id)
      const key = this.finalKey(bucketId, String(r.name), String(r.version))
      const stat = await this.blob.stat(key).catch(() => null)
      if (r.state === 'staging') {
        if (stat) {
          await this.db.run(
            `UPDATE ${this.O()} SET state = 'ready', size = ?, sha256 = ?, updated_at = ? WHERE id = ? AND state = 'staging'`,
            [this.i64(stat.bytes), stat.sha256, this.ports.clock.now(), String(r.id)],
          )
          stats.promoted++
        } else {
          await this.db.run(`DELETE FROM ${this.O()} WHERE id = ?`, [String(r.id)])
          stats.aborted++
        }
      } else if (r.state === 'deleting') {
        await this.blob.delete(key).catch(() => undefined)
        await this.db.run(`DELETE FROM ${this.O()} WHERE id = ?`, [String(r.id)])
        stats.deleted++
      }
    }
    // ready rows whose bytes vanished → corrupt
    const ready = await this.db.all(`SELECT * FROM ${this.O()} WHERE state = 'ready'`)
    for (const r of ready) {
      const key = this.finalKey(String(r.bucket_id), String(r.name), String(r.version))
      if (!(await this.blob.stat(key).catch(() => null))) {
        await this.db.run(`UPDATE ${this.O()} SET state = 'corrupt', updated_at = ? WHERE id = ?`, [
          this.ports.clock.now(),
          String(r.id),
        ])
        stats.corrupted++
      }
    }
    // orphan staged blobs older than the TTL
    const cutoff =
      staleBeforeIso ?? new Date(this.ports.clock.epochMillis() - 24 * 3600_000).toISOString()
    for await (const staged of this.blob.listStaged(cutoff)) {
      const owned = await this.db.one(`SELECT id FROM ${this.O()} WHERE op_id = ?`, [staged.opId])
      if (!owned) {
        await this.blob.delete(staged.stagedKey).catch(() => undefined)
        stats.deleted++
      }
    }
    return stats
  }

  // ---- internals ----

  private async authorize(
    principal: Principal,
    action: 'storage.read' | 'storage.write',
    resource: { bucket_id: string; name: string; owner: string | null },
  ): Promise<void> {
    if (isPrivilegedService(principal)) return
    const hasStoragePolicy = this.policySchema.policies.some(
      (p) => p.action === action && p.table === 'objects',
    )
    if (!hasStoragePolicy) {
      // default: authenticated principals may operate on non-public buckets; anon may not
      if (principal.kind === 'anonymous') throw STORAGE_ERRORS.notAuthorized()
      return
    }
    const plan = buildSecurityPlan(
      {
        schema: this.policySchema,
        rules: this.policySchema.policies,
        principal,
        now: this.ports.clock.now(),
      },
      { table: 'objects', action },
    )
    if (plan.decision === 'deny') throw STORAGE_ERRORS.notAuthorized()
    const row: Record<string, Json> = {
      bucket_id: resource.bucket_id,
      name: resource.name,
      owner: resource.owner,
    }
    const usingOk =
      plan.rowUsing === null ||
      checkRowAllowed({ ...plan, rowCheck: plan.rowUsing }, row, this.ports.clock.now())
    const checkOk =
      action === 'storage.write' ? checkRowAllowed(plan, row, this.ports.clock.now()) : true
    if (!usingOk || !checkOk) throw STORAGE_ERRORS.notAuthorized()
  }

  private finalKey(bucketId: string, name: string, version: string): string {
    return `${bucketId}/${name}#${version}`
  }

  private async currentReady(
    bucketId: string,
    name: string,
  ): Promise<
    | (Record<string, unknown> & {
        id: string
        name: string
        version: string
        owner: string | null
        size: number
        content_type: string | null
        cache_control: string | null
        created_at: string
        updated_at: string
      })
    | null
  > {
    const row = await this.db.one(
      `SELECT * FROM ${this.O()} WHERE bucket_id = ? AND name = ? AND state = 'ready' ORDER BY created_at DESC`,
      [bucketId, name],
    )
    if (!row) return null
    return {
      ...row,
      id: String(row.id),
      name: String(row.name),
      version: String(row.version),
      owner: (row.owner as string | null) ?? null,
      size: Number(row.size ?? 0),
      content_type: (row.content_type as string | null) ?? null,
      cache_control: (row.cache_control as string | null) ?? null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }
  }

  private requireObject(
    bucketId: string,
    name: string,
  ): Promise<NonNullable<Awaited<ReturnType<StorageService['currentReady']>>>> {
    return this.currentReady(bucketId, name).then((o) => {
      if (!o) throw STORAGE_ERRORS.objectNotFound()
      return o
    })
  }

  private objectInfo(o: {
    id: string
    name: string
    size: number
    content_type: string | null
    cache_control: string | null
    created_at: string
    updated_at: string
  }): ObjectInfo {
    return {
      id: o.id,
      bucket_id: '',
      name: o.name,
      size: o.size,
      content_type: o.content_type,
      cache_control: o.cache_control,
      metadata: { size: o.size, mimetype: o.content_type },
      created_at: o.created_at,
      updated_at: o.updated_at,
    }
  }

  private bucketView(row: Record<string, unknown>): BucketInfo {
    return {
      id: String(row.id),
      name: String(row.name),
      public: row.public === true || row.public === 1,
      file_size_limit: row.file_size_limit == null ? null : Number(row.file_size_limit),
      allowed_mime_types: row.allowed_mime_types
        ? (JSON.parse(String(row.allowed_mime_types)) as string[])
        : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }
  }

  private bool(v: boolean): boolean | number {
    return this.db.family === 'postgres' ? v : v ? 1 : 0
  }
  private i64(n: number): string | number {
    return this.db.family === 'postgres' ? n : String(n)
  }
}
