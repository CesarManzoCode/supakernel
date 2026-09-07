/**
 * The canonical SupaKernel fixture scenario (contract §10, §11.3, §30 L10).
 *
 * It exercises the common Data / Auth / Storage surface that every runtime profile must
 * support and returns a machine-readable pass list, so the six receipts are comparable. It
 * imports no `@supakernel/*` package. It does not import `@supabase/supabase-js` either — the
 * caller (a runtime harness) supplies a real client factory, because each profile creates the
 * client differently (real HTTP, an in-process handler, a MessageChannel bridge).
 */

export interface PostgrestLike<T = Record<string, unknown>> extends PromiseLike<Result<T[]>> {
  select(columns?: string): PostgrestLike<T>
  insert(values: Record<string, unknown>): PostgrestLike<T>
  update(values: Record<string, unknown>): PostgrestLike<T>
  delete(): PostgrestLike<T>
  eq(column: string, value: unknown): PostgrestLike<T>
  single(): PromiseLike<Result<T>>
}

export interface Result<T> {
  data: T | null
  error: { message: string } | null
}

export interface StorageFileApi {
  upload(path: string, body: unknown, options?: Record<string, unknown>): Promise<Result<unknown>>
  download(path: string): Promise<Result<{ arrayBuffer(): Promise<ArrayBuffer> }>>
  list(prefix?: string): Promise<Result<{ name: string }[]>>
  remove(paths: string[]): Promise<Result<unknown>>
}

export interface ErrorShape {
  message: string
}
export interface AuthResult {
  data: { session: Session | null; user: UserInfo | null }
  error: ErrorShape | null
}
export interface AuthLike {
  signUp(credentials: { email: string; password: string }): Promise<AuthResult>
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResult>
  getUser(token?: string): Promise<{ data: { user: UserInfo | null }; error: ErrorShape | null }>
  getSession(): Promise<{ data: { session: Session | null } }>
  signOut(): Promise<{ error: ErrorShape | null }>
}

export interface Session {
  access_token: string
}
export interface UserInfo {
  id: string
  email?: string
}

export interface FixtureClient {
  auth: AuthLike
  from(table: string): PostgrestLike
  storage: {
    createBucket(id: string, options?: Record<string, unknown>): Promise<Result<unknown>>
    from(id: string): StorageFileApi
  }
}

export interface FixtureOptions {
  /** Make a fresh client instance (one per identity). */
  readonly newClient: () => FixtureClient
  /** Receipt label, e.g. `node`, `workers`, `browser (pglite)`. */
  readonly label: string
}

export interface FixtureCase {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

export interface FixtureReport {
  readonly label: string
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly cases: readonly FixtureCase[]
}

/** The table the fixture drives; a runtime harness deploys it before calling the scenario. */
export const FIXTURE_TABLE = 'notes'

/** A 123-byte object — the storage signed-URL regression fixture size (contract §30 L7, #64). */
export const FIXTURE_BYTES: Uint8Array = new Uint8Array(123).map((_v, i) => (i * 7 + 3) & 0xff)

interface Runner {
  readonly cases: FixtureCase[]
  step(name: string, fn: () => Promise<void>): Promise<void>
}

function runner(): Runner {
  const cases: FixtureCase[] = []
  return {
    cases,
    async step(name, fn) {
      try {
        await fn()
        cases.push({ name, ok: true })
      } catch (err) {
        cases.push({ name, ok: false, error: (err as Error).message ?? String(err) })
      }
    },
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

/**
 * Run the shared Data / Auth / Storage scenario. Never throws: every failure is captured as a
 * case so a caller can render one receipt per runtime.
 */
export async function runFixtureScenario(opts: FixtureOptions): Promise<FixtureReport> {
  const r = runner()
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const emailA = `alice-${uniq}@fixture.test`
  const emailB = `bob-${uniq}@fixture.test`
  const password = 'password-fixture-123'

  const alice = opts.newClient()
  const bob = opts.newClient()
  let aliceId = ''
  const noteId = `n-${uniq}`

  await r.step('auth: sign up user A', async () => {
    const { data, error } = await alice.auth.signUp({ email: emailA, password })
    assert(!error, `signUp A: ${error?.message}`)
    assert(data.session?.access_token, 'signUp A returned no session')
    assert(data.user?.id, 'signUp A returned no user id')
    aliceId = data.user?.id ?? ''
  })

  await r.step('auth: sign in user A', async () => {
    const { data, error } = await alice.auth.signInWithPassword({ email: emailA, password })
    assert(!error, `signIn A: ${error?.message}`)
    assert(data.session?.access_token, 'signIn A returned no session')
  })

  await r.step('auth: getUser reflects the signed-in identity', async () => {
    const { data, error } = await alice.auth.getUser()
    assert(!error, `getUser A: ${error?.message}`)
    assert(
      data.user?.email === emailA.toLowerCase(),
      `getUser A email mismatch: ${data.user?.email}`,
    )
  })

  await r.step('data: A inserts an owned row (WITH CHECK passes)', async () => {
    const { data, error } = await alice
      .from(FIXTURE_TABLE)
      .insert({ id: noteId, owner_id: aliceId, title: 'hello from A' })
      .select('id, owner_id, title')
      .single()
    assert(!error, `insert A: ${error?.message}`)
    assert(
      (data as { title?: string } | null)?.title === 'hello from A',
      'insert A: row not returned',
    )
  })

  await r.step('data: A reads back exactly its own row', async () => {
    const { data, error } = await alice.from(FIXTURE_TABLE).select('id, title')
    assert(!error, `select A: ${error?.message}`)
    assert(Array.isArray(data) && data.length === 1, `select A expected 1 row, got ${data?.length}`)
  })

  await r.step('data: an anon insert is rejected (default-deny)', async () => {
    const anon = opts.newClient()
    const { error } = await anon
      .from(FIXTURE_TABLE)
      .insert({ id: `anon-${uniq}`, owner_id: aliceId, title: 'forged' })
    assert(error, 'anon insert should have been rejected')
  })

  await r.step('data: A updates its row title', async () => {
    const { data, error } = await alice
      .from(FIXTURE_TABLE)
      .update({ title: 'updated by A' })
      .eq('id', noteId)
      .select('title')
      .single()
    assert(!error, `update A: ${error?.message}`)
    assert((data as { title?: string } | null)?.title === 'updated by A', 'update A: not persisted')
  })

  await r.step('auth: sign up + sign in user B', async () => {
    const { error: sErr } = await bob.auth.signUp({ email: emailB, password })
    assert(!sErr, `signUp B: ${sErr?.message}`)
    const { error } = await bob.auth.signInWithPassword({ email: emailB, password })
    assert(!error, `signIn B: ${error?.message}`)
  })

  await r.step('data: B cannot see A rows (row-level isolation)', async () => {
    const { data, error } = await bob.from(FIXTURE_TABLE).select('id')
    assert(!error, `select B: ${error?.message}`)
    assert(Array.isArray(data) && data.length === 0, `B saw ${data?.length} of A's rows`)
  })

  await r.step('data: B cannot insert a row owned by A (WITH CHECK)', async () => {
    const { error } = await bob
      .from(FIXTURE_TABLE)
      .insert({ id: `b-${uniq}`, owner_id: aliceId, title: 'cross-tenant' })
    assert(error, "B's cross-owner insert should have been rejected")
  })

  await r.step('storage: A round-trips an object through a bucket', async () => {
    const bucket = `docs-${uniq}`
    const { error: cErr } = await alice.storage.createBucket(bucket)
    assert(!cErr, `createBucket: ${cErr?.message}`)
    const { error: uErr } = await alice.storage
      .from(bucket)
      .upload('reports/a.bin', FIXTURE_BYTES, { contentType: 'application/octet-stream' })
    assert(!uErr, `upload: ${uErr?.message}`)
    const { data: dl, error: dErr } = await alice.storage.from(bucket).download('reports/a.bin')
    assert(!dErr, `download: ${dErr?.message}`)
    const got = new Uint8Array((await dl?.arrayBuffer()) ?? new ArrayBuffer(0))
    assert(got.length === FIXTURE_BYTES.length, `download length ${got.length}`)
    assert(
      got.every((b, i) => b === FIXTURE_BYTES[i]),
      'downloaded bytes differ from upload',
    )
    const { data: list, error: lErr } = await alice.storage.from(bucket).list('reports')
    assert(!lErr, `list: ${lErr?.message}`)
    assert(
      list?.some((o) => o.name === 'a.bin'),
      'list did not include the uploaded object',
    )
    const { error: rErr } = await alice.storage.from(bucket).remove(['reports/a.bin'])
    assert(!rErr, `remove: ${rErr?.message}`)
    const after = await alice.storage.from(bucket).download('reports/a.bin')
    assert(after.error, 'object should be gone after remove')
  })

  await r.step('data: A deletes its row', async () => {
    const { error } = await alice.from(FIXTURE_TABLE).delete().eq('id', noteId)
    assert(!error, `delete A: ${error?.message}`)
    const { data } = await alice.from(FIXTURE_TABLE).select('id')
    assert(Array.isArray(data) && data.length === 0, 'row still present after delete')
  })

  await r.step('auth: A signs out; the token no longer authenticates', async () => {
    const token = (await alice.auth.getSession()).data.session?.access_token
    await alice.auth.signOut()
    const probe = opts.newClient()
    const { error } = await probe.auth.getUser(token)
    assert(error, 'access token still valid after global sign-out')
  })

  const passed = r.cases.filter((c) => c.ok).length
  return {
    label: opts.label,
    total: r.cases.length,
    passed,
    failed: r.cases.length - passed,
    cases: r.cases,
  }
}
