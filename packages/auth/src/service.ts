import {
  bytesToBase64Url,
  type DbRow,
  type Family,
  type Json,
  type Principal,
} from '@supakernel/contracts'
import type { CryptoPort, DatabaseAdapter } from '@supakernel/ports'
import { mintApiKeys, resolveApiKey } from './apikeys.js'
import { type AuthConfig, type AuthPorts, DEFAULT_AUTH_CONFIG } from './config.js'
import {
  createWebCryptoPort,
  generateSigningKey,
  JwtKeyring,
  needsRehash,
  type SigningKeyPair,
} from './crypto/index.js'
import { AuthDb, boolValue, readBool } from './db.js'
import { AUTH_ERRORS, AuthError } from './errors.js'
import { DEFAULT_RATE_LIMITS, RateLimiter } from './ratelimit.js'
import { authTable } from './schema.js'
import {
  type IssuedTokens,
  issueSession,
  revokeSessions,
  rotateRefresh,
  type SessionDeps,
  sessionActive,
} from './session.js'
import { hashToken } from './tokens.js'

const PROTECTED_META_KEYS = new Set(['role', 'tenant_id', 'is_super_admin', 'is_anonymous', 'aud'])

export interface AuthUser {
  id: string
  aud: string
  role: string
  email: string | null
  email_confirmed_at: string | null
  confirmed_at: string | null
  last_sign_in_at: string | null
  app_metadata: Json
  user_metadata: Json
  identities: Json[]
  created_at: string
  updated_at: string
  is_anonymous: boolean
}

export interface AuthSession extends IssuedTokens {
  readonly token_type: 'bearer'
  readonly user: AuthUser
}

export interface CreateAuthServiceOptions {
  readonly adapter: DatabaseAdapter
  readonly crypto?: CryptoPort
  readonly ports: AuthPorts
  readonly config: Pick<AuthConfig, 'projectRef' | 'serverSecret'> & Partial<AuthConfig>
}

export class AuthService {
  readonly db: AuthDb
  readonly crypto: CryptoPort
  readonly ports: AuthPorts
  readonly config: AuthConfig
  private readonly keyring: JwtKeyring
  private readonly rateLimiter: RateLimiter
  readonly apiKeys: { publishable: string; secret: string }

  private constructor(fields: {
    db: AuthDb
    crypto: CryptoPort
    ports: AuthPorts
    config: AuthConfig
    keyring: JwtKeyring
    rateLimiter: RateLimiter
    apiKeys: { publishable: string; secret: string }
  }) {
    this.db = fields.db
    this.crypto = fields.crypto
    this.ports = fields.ports
    this.config = fields.config
    this.keyring = fields.keyring
    this.rateLimiter = fields.rateLimiter
    this.apiKeys = fields.apiKeys
  }

  static async create(opts: CreateAuthServiceOptions): Promise<AuthService> {
    const family: Family = opts.adapter.capabilities.family
    const db = new AuthDb(opts.adapter, family)
    const config: AuthConfig = {
      ...DEFAULT_AUTH_CONFIG,
      issuer: opts.config.issuer ?? `https://${opts.config.projectRef}.supakernel`,
      ...opts.config,
    }

    const T = authTable('signing_keys', family)
    let keyRows = await db.all(
      `SELECT kid, alg, status, private_jwk, public_jwk FROM ${T} ORDER BY created_at`,
    )
    if (keyRows.length === 0) {
      const key = await generateSigningKey()
      await db.run(
        `INSERT INTO ${T} (kid, alg, status, private_jwk, public_jwk, created_at) VALUES (?,?,?,?,?,?)`,
        [
          key.kid,
          key.alg,
          'active',
          JSON.stringify(key.privateJwk),
          JSON.stringify(key.publicJwk),
          new Date().toISOString(),
        ],
      )
      keyRows = await db.all(
        `SELECT kid, alg, status, private_jwk, public_jwk FROM ${T} ORDER BY created_at`,
      )
    }
    const keys: SigningKeyPair[] = keyRows.map((r) => ({
      kid: String(r.kid),
      alg: 'ES256' as const,
      status: (r.status === 'active' ? 'active' : 'retired') as 'active' | 'retired',
      privateJwk: parseJson(r.private_jwk) as unknown as SigningKeyPair['privateJwk'],
      publicJwk: parseJson(r.public_jwk) as unknown as SigningKeyPair['publicJwk'],
    }))
    const keyring = await JwtKeyring.fromKeys(keys)
    const crypto: CryptoPort = opts.crypto ?? (await createWebCryptoPort(keys))
    const apiKeys = await mintApiKeys(db, crypto, config)
    return new AuthService({
      db,
      crypto,
      ports: opts.ports,
      config,
      keyring,
      rateLimiter: new RateLimiter(opts.ports.clock, DEFAULT_RATE_LIMITS),
      apiKeys,
    })
  }

  private sessionDeps(): SessionDeps {
    return {
      db: this.db,
      crypto: this.crypto,
      ports: this.ports,
      config: this.config,
      activeKid: () => this.keyring.activeKeyId,
      buildAccessClaims: async (userId) => {
        const u = await this.userRow(userId)
        if (!u) throw AUTH_ERRORS.userNotFound()
        return {
          sub: userId,
          role: String(u.role),
          email: u.email ?? undefined,
          app_metadata: parseJson(u.raw_app_meta_data),
          user_metadata: parseJson(u.raw_user_meta_data),
          is_anonymous: readBool(u.is_anonymous),
        }
      },
    }
  }

  private T(n: Parameters<typeof authTable>[0]): string {
    return authTable(n, this.db.family)
  }

  async signUp(input: {
    email: string
    password: string
    data?: Record<string, Json>
    ip?: string
    ipClass?: string
  }): Promise<{ user: AuthUser; session: AuthSession | null }> {
    this.limit('signup', input.ipClass, input.email)
    const email = canonicalEmail(input.email)
    if (input.password.length < this.config.minPasswordLength) throw AUTH_ERRORS.weakPassword()
    if (await this.db.one(`SELECT id FROM ${this.T('users')} WHERE email = ?`, [email])) {
      throw AUTH_ERRORS.userAlreadyExists()
    }

    const now = this.ports.clock.now()
    const id = this.ports.random.uuidV4()
    const encrypted = await this.crypto.hashPassword(input.password)
    const userMeta = sanitizeMeta(input.data ?? {})
    const confirmedAt = this.config.autoConfirm ? now : null

    await this.db.run(
      `INSERT INTO ${this.T('users')} (id, email, encrypted_password, email_confirmed_at, role, aud, is_super_admin, is_anonymous, is_sso_user, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        email,
        encrypted,
        confirmedAt,
        'authenticated',
        this.config.audience,
        boolValue(this.db.family, false),
        boolValue(this.db.family, false),
        boolValue(this.db.family, false),
        JSON.stringify({ provider: 'email', providers: ['email'] }),
        JSON.stringify(userMeta),
        now,
        now,
      ],
    )
    await this.db.run(
      `INSERT INTO ${this.T('identities')} (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [
        this.ports.random.uuidV4(),
        id,
        'email',
        id,
        JSON.stringify({ sub: id, email }),
        confirmedAt,
        now,
        now,
      ],
    )
    await this.audit('user_signedup', id, input.ip, { provider: 'email' })

    if (!this.config.autoConfirm) {
      await this.issueOneTimeToken(id, 'confirmation', email, 'confirmation')
      return { user: await this.userView(id), session: null }
    }
    const session = await this.issueFullSession(id, input.ip)
    return { user: session.user, session }
  }

  async signInWithPassword(input: {
    email: string
    password: string
    ip?: string
    ipClass?: string
  }): Promise<AuthSession> {
    this.limit('token:password', input.ipClass, input.email)
    const email = canonicalEmail(input.email)
    const u = await this.db.one(`SELECT * FROM ${this.T('users')} WHERE email = ?`, [email])
    if (!u || u.encrypted_password === null) {
      await this.crypto.hashPassword(input.password)
      throw AUTH_ERRORS.invalidCredentials()
    }
    if (!(await this.crypto.verifyPassword(input.password, String(u.encrypted_password)))) {
      throw AUTH_ERRORS.invalidCredentials()
    }
    if (u.email_confirmed_at === null && !this.config.autoConfirm)
      throw AUTH_ERRORS.invalidCredentials()
    if (
      u.banned_until !== null &&
      u.banned_until !== undefined &&
      Date.parse(String(u.banned_until)) > this.ports.clock.epochMillis()
    ) {
      throw AUTH_ERRORS.invalidCredentials()
    }

    if (needsRehash(String(u.encrypted_password))) {
      await this.db.run(
        `UPDATE ${this.T('users')} SET encrypted_password = ?, updated_at = ? WHERE id = ?`,
        [await this.crypto.hashPassword(input.password), this.ports.clock.now(), String(u.id)],
      )
    }
    await this.db.run(
      `UPDATE ${this.T('users')} SET last_sign_in_at = ?, updated_at = ? WHERE id = ?`,
      [this.ports.clock.now(), this.ports.clock.now(), String(u.id)],
    )
    await this.audit('login', String(u.id), input.ip, { provider: 'email' })
    return this.issueFullSession(String(u.id), input.ip)
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const tokens = await rotateRefresh(this.sessionDeps(), refreshToken)
    return {
      ...tokens,
      token_type: 'bearer',
      user: await this.userView(await this.userIdForSession(tokens.sessionId)),
    }
  }

  async getUser(accessToken: string): Promise<AuthUser> {
    const claims = await this.verifyAccessToken(accessToken)
    return this.userView(String(claims.sub))
  }

  async updateUser(
    accessToken: string,
    patch: { password?: string; email?: string; data?: Record<string, Json> },
  ): Promise<AuthUser> {
    const claims = await this.verifyAccessToken(accessToken)
    const userId = String(claims.sub)
    const now = this.ports.clock.now()
    const sets: string[] = []
    const params: (string | number | null)[] = []

    if (patch.password !== undefined) {
      if (patch.password.length < this.config.minPasswordLength) throw AUTH_ERRORS.weakPassword()
      sets.push('encrypted_password = ?')
      params.push(await this.crypto.hashPassword(patch.password))
    }
    if (patch.data !== undefined) {
      const current = parseJson((await this.userRow(userId))?.raw_user_meta_data) as Record<
        string,
        Json
      >
      sets.push('raw_user_meta_data = ?')
      params.push(JSON.stringify({ ...current, ...sanitizeMeta(patch.data) }))
    }
    let newEmail: string | null = null
    if (patch.email !== undefined) {
      newEmail = canonicalEmail(patch.email)
      if (
        await this.db.one(`SELECT id FROM ${this.T('users')} WHERE email = ? AND id <> ?`, [
          newEmail,
          userId,
        ])
      ) {
        throw AUTH_ERRORS.userAlreadyExists()
      }
      if (this.config.autoConfirm) {
        sets.push('email = ?')
        params.push(newEmail)
      } else {
        sets.push('email_change = ?')
        params.push(newEmail)
      }
    }
    if (sets.length === 0) return this.userView(userId)
    sets.push('updated_at = ?')
    params.push(now, userId)
    await this.db.run(`UPDATE ${this.T('users')} SET ${sets.join(', ')} WHERE id = ?`, params)

    if (patch.password !== undefined) {
      await revokeSessions(this.sessionDeps(), userId, String(claims.session_id ?? ''), 'others')
      await this.audit('user_updated_password', userId, undefined, {})
    }
    if (newEmail && !this.config.autoConfirm) {
      await this.issueOneTimeToken(userId, 'email_change', newEmail, 'email_change_current')
    }
    return this.userView(userId)
  }

  async signOut(accessToken: string, scope: 'local' | 'global' | 'others'): Promise<void> {
    const claims = await this.verifyAccessToken(accessToken).catch(() => null)
    if (!claims) return
    await revokeSessions(
      this.sessionDeps(),
      String(claims.sub),
      String(claims.session_id ?? ''),
      scope,
    )
    await this.audit('logout', String(claims.sub), undefined, { scope })
  }

  async recover(input: { email: string; ipClass?: string }): Promise<void> {
    this.limit('recover', input.ipClass, input.email)
    const email = canonicalEmail(input.email)
    const u = await this.db.one(`SELECT id FROM ${this.T('users')} WHERE email = ?`, [email])
    if (u) await this.issueOneTimeToken(String(u.id), 'recovery', email, 'recovery')
  }

  async verify(input: {
    type: string
    token: string
    email?: string
    ipClass?: string
  }): Promise<AuthSession> {
    this.limit('verify', input.ipClass, input.email ?? '')
    const valid = new Set(['recovery', 'signup', 'email_change', 'magiclink', 'invite'])
    if (!valid.has(input.type)) throw AUTH_ERRORS.unsupported(`verify type "${input.type}"`)
    const hash = await hashToken(this.crypto, input.token)
    const row = await this.db.one(
      `SELECT id, user_id, expires_at FROM ${this.T('one_time_tokens')} WHERE token_hash = ? AND token_type = ?`,
      [hash, input.type === 'signup' ? 'confirmation' : input.type],
    )
    if (!row || Date.parse(String(row.expires_at)) < this.ports.clock.epochMillis())
      throw AUTH_ERRORS.otpExpired()
    const userId = String(row.user_id)
    const now = this.ports.clock.now()
    await this.db.run(`DELETE FROM ${this.T('one_time_tokens')} WHERE id = ?`, [String(row.id)])
    if (input.type === 'signup') {
      await this.db.run(
        `UPDATE ${this.T('users')} SET email_confirmed_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, userId],
      )
    }
    if (input.type === 'email_change') {
      await this.db.run(
        `UPDATE ${this.T('users')} SET email = email_change, email_change = NULL, updated_at = ? WHERE id = ?`,
        [now, userId],
      )
    }
    await this.audit(`verify_${input.type}`, userId, undefined, {})
    return this.issueFullSession(userId)
  }

  get signingKeyId(): string {
    return this.keyring.activeKeyId
  }

  unsupported(feature: string): AuthError {
    return AUTH_ERRORS.unsupported(feature)
  }

  settings(): Json {
    return {
      external: { email: true, phone: false, anonymous: false },
      disable_signup: false,
      mailer_autoconfirm: this.config.autoConfirm,
      phone_autoconfirm: false,
      sms_provider: '',
      saml_enabled: false,
    }
  }

  async health(): Promise<Json> {
    const key = await this.db.one(
      `SELECT kid FROM ${this.T('signing_keys')} WHERE status = 'active'`,
    )
    return {
      version: 'supakernel-auth-1',
      name: 'SupaKernel Auth',
      description: 'GoTrue subset',
      healthy: Boolean(key),
    }
  }

  async jwks(): Promise<Json> {
    const rows = await this.db.all(`SELECT kid, public_jwk FROM ${this.T('signing_keys')}`)
    return {
      keys: rows.map((r) => ({
        ...(parseJson(r.public_jwk) as Record<string, Json>),
        kid: String(r.kid),
        use: 'sig',
        alg: 'ES256',
      })),
    }
  }

  readonly admin = {
    createUser: async (
      caller: Principal,
      input: {
        email: string
        password?: string | undefined
        email_confirm?: boolean | undefined
        user_metadata?: Record<string, Json> | undefined
        app_metadata?: Record<string, Json> | undefined
        role?: string | undefined
      },
    ): Promise<AuthUser> => {
      this.assertAdmin(caller)
      const email = canonicalEmail(input.email)
      if (await this.db.one(`SELECT id FROM ${this.T('users')} WHERE email = ?`, [email]))
        throw AUTH_ERRORS.userAlreadyExists()
      const now = this.ports.clock.now()
      const id = this.ports.random.uuidV4()
      const encrypted = input.password ? await this.crypto.hashPassword(input.password) : null
      await this.db.run(
        `INSERT INTO ${this.T('users')} (id, email, encrypted_password, email_confirmed_at, role, aud, is_super_admin, is_anonymous, is_sso_user, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          email,
          encrypted,
          input.email_confirm === false ? null : now,
          input.role ?? 'authenticated',
          this.config.audience,
          boolValue(this.db.family, false),
          boolValue(this.db.family, false),
          boolValue(this.db.family, false),
          JSON.stringify({
            provider: 'email',
            providers: ['email'],
            ...(input.app_metadata ?? {}),
          }),
          JSON.stringify(sanitizeMeta(input.user_metadata ?? {})),
          now,
          now,
        ],
      )
      await this.audit('user_created', id, undefined, { by: 'admin' })
      return this.userView(id)
    },
    getUser: async (caller: Principal, id: string): Promise<AuthUser> => {
      this.assertAdmin(caller)
      return this.userView(id)
    },
    listUsers: async (caller: Principal): Promise<{ users: AuthUser[] }> => {
      this.assertAdmin(caller)
      const rows = await this.db.all(`SELECT id FROM ${this.T('users')} ORDER BY created_at`)
      return { users: await Promise.all(rows.map((r) => this.userView(String(r.id)))) }
    },
    updateUser: async (
      caller: Principal,
      id: string,
      patch: {
        password?: string | undefined
        email?: string | undefined
        role?: string | undefined
        ban_duration?: string | undefined
        user_metadata?: Record<string, Json> | undefined
        app_metadata?: Record<string, Json> | undefined
      },
    ): Promise<AuthUser> => {
      this.assertAdmin(caller)
      const now = this.ports.clock.now()
      const sets: string[] = []
      const params: (string | number | null)[] = []
      if (patch.password !== undefined) {
        sets.push('encrypted_password = ?')
        params.push(await this.crypto.hashPassword(patch.password))
      }
      if (patch.email !== undefined) {
        sets.push('email = ?')
        params.push(canonicalEmail(patch.email))
      }
      if (patch.role !== undefined) {
        sets.push('role = ?')
        params.push(patch.role)
      }
      if (patch.user_metadata !== undefined) {
        sets.push('raw_user_meta_data = ?')
        params.push(JSON.stringify(sanitizeMeta(patch.user_metadata)))
      }
      if (patch.app_metadata !== undefined) {
        sets.push('raw_app_meta_data = ?')
        params.push(JSON.stringify(patch.app_metadata))
      }
      if (patch.ban_duration !== undefined) {
        sets.push('banned_until = ?')
        params.push(
          patch.ban_duration === 'none'
            ? null
            : new Date(
                this.ports.clock.epochMillis() + parseDuration(patch.ban_duration),
              ).toISOString(),
        )
      }
      if (sets.length === 0) return this.userView(id)
      sets.push('updated_at = ?')
      params.push(now, id)
      await this.db.run(`UPDATE ${this.T('users')} SET ${sets.join(', ')} WHERE id = ?`, params)
      await this.audit('user_updated', id, undefined, { by: 'admin' })
      return this.userView(id)
    },
    deleteUser: async (caller: Principal, id: string): Promise<void> => {
      this.assertAdmin(caller)
      await this.db.run(`DELETE FROM ${this.T('users')} WHERE id = ?`, [id])
      await this.audit('user_deleted', id, undefined, { by: 'admin' })
    },
  }

  /**
   * Resolve the verified principal from request headers (contract §12.2): a publishable `apikey`
   * yields `anon`; a verified bearer JWT of this project replaces it with the user; only a
   * secret key presented as `apikey` yields `service_role` — a role claim or secret placed only
   * in `Authorization` never elevates.
   */
  async resolvePrincipal(headers: { get(name: string): string | null }): Promise<Principal> {
    const apikey = headers.get('apikey') ?? ''
    const bearer = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()

    const resolvedKey = apikey
      ? await resolveApiKey(this.db, this.crypto, this.config, apikey)
      : null
    if (!resolvedKey) throw AUTH_ERRORS.badJwt()

    const tenantId = this.config.projectRef
    let principal: Principal =
      resolvedKey.type === 'secret'
        ? {
            kind: 'service',
            subjectId: null,
            tenantId,
            role: 'service_role',
            sessionId: null,
            claims: Object.freeze({}),
            credentialSource: 'secret_key',
          }
        : {
            kind: 'anonymous',
            subjectId: null,
            tenantId,
            role: 'anon',
            sessionId: null,
            claims: Object.freeze({}),
            credentialSource: 'none',
          }

    if (bearer && bearer !== apikey) {
      const claims = await this.verifyAccessToken(bearer).catch(() => null)
      if (claims) {
        principal = {
          kind: 'user',
          subjectId: String(claims.sub),
          tenantId,
          role: String(claims.role ?? 'authenticated'),
          sessionId: claims.session_id ? String(claims.session_id) : null,
          claims: Object.freeze({ ...claims } as Record<string, Json>),
          credentialSource: 'jwt',
        }
      }
    }
    return principal
  }

  private async verifyAccessToken(token: string): Promise<Record<string, unknown>> {
    const result = await this.keyring.verify(
      token,
      { issuer: this.config.issuer, audience: this.config.audience, algorithms: ['ES256'] },
      new Date(this.ports.clock.epochMillis()),
    )
    if (!result.ok) throw AUTH_ERRORS.badJwt()
    const sessionId = result.claims.session_id ? String(result.claims.session_id) : null
    if (sessionId && !(await sessionActive(this.sessionDeps(), sessionId)))
      throw AUTH_ERRORS.sessionNotFound()
    return result.claims
  }

  private async issueFullSession(userId: string, ip?: string): Promise<AuthSession> {
    const tokens = await issueSession(this.sessionDeps(), userId, ip === undefined ? {} : { ip })
    return { ...tokens, token_type: 'bearer', user: await this.userView(userId) }
  }

  private userRow(id: string): Promise<DbRow | null> {
    return this.db.one(`SELECT * FROM ${this.T('users')} WHERE id = ?`, [id])
  }

  private async userIdForSession(sessionId: string): Promise<string> {
    const row = await this.db.one(`SELECT user_id FROM ${this.T('sessions')} WHERE id = ?`, [
      sessionId,
    ])
    if (!row) throw AUTH_ERRORS.sessionNotFound()
    return String(row.user_id)
  }

  async userView(id: string): Promise<AuthUser> {
    const u = await this.userRow(id)
    if (!u) throw AUTH_ERRORS.userNotFound()
    const identities = await this.db.all(
      `SELECT id, provider, identity_data, created_at, updated_at, last_sign_in_at FROM ${this.T('identities')} WHERE user_id = ?`,
      [id],
    )
    return {
      id: String(u.id),
      aud: String(u.aud),
      role: String(u.role),
      email: (u.email as string | null) ?? null,
      email_confirmed_at: (u.email_confirmed_at as string | null) ?? null,
      confirmed_at: (u.email_confirmed_at as string | null) ?? null,
      last_sign_in_at: (u.last_sign_in_at as string | null) ?? null,
      app_metadata: parseJson(u.raw_app_meta_data),
      user_metadata: parseJson(u.raw_user_meta_data),
      identities: identities.map((i) => ({
        id: String(i.id),
        user_id: id,
        identity_id: String(i.id),
        provider: String(i.provider),
        identity_data: parseJson(i.identity_data),
        created_at: String(i.created_at),
        updated_at: String(i.updated_at),
        last_sign_in_at: (i.last_sign_in_at as string | null) ?? null,
      })),
      created_at: String(u.created_at),
      updated_at: String(u.updated_at),
      is_anonymous: readBool(u.is_anonymous),
    }
  }

  private assertAdmin(caller: Principal): void {
    if (
      !(
        caller.kind === 'service' &&
        caller.role === 'service_role' &&
        caller.credentialSource === 'secret_key'
      )
    ) {
      throw AUTH_ERRORS.notAdmin()
    }
  }

  private limit(action: string, ipClass: string | undefined, email: string): void {
    if (!this.rateLimiter.take(action, `${ipClass ?? 'unknown'}:${email.toLowerCase()}`)) {
      throw AUTH_ERRORS.rateLimited()
    }
  }

  private async issueOneTimeToken(
    userId: string,
    type: string,
    relatesTo: string,
    templateId: string,
  ): Promise<void> {
    const token = bytesToBase64Url(this.ports.random.bytes(24))
    const now = this.ports.clock.now()
    const expires = new Date(this.ports.clock.epochMillis() + 3600_000).toISOString()
    await this.db.run(
      `INSERT INTO ${this.T('one_time_tokens')} (id, user_id, token_type, token_hash, relates_to, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
      [
        this.ports.random.uuidV4(),
        userId,
        type,
        await hashToken(this.crypto, token),
        relatesTo,
        now,
        expires,
      ],
    )
    await this.ports.mail.send({ to: relatesTo, templateId, variables: { token, type } })
    await this.audit(`otp_${type}`, userId, undefined, {})
  }

  private async audit(
    action: string,
    actorId: string | null,
    actorIp: string | undefined,
    traits: Record<string, Json>,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO ${this.T('audit_log')} (id, action, actor_id, actor_ip, traits, created_at) VALUES (?,?,?,?,?,?)`,
      [
        this.ports.random.uuidV4(),
        action,
        actorId,
        actorIp ?? null,
        JSON.stringify(redactTraits(traits)),
        this.ports.clock.now(),
      ],
    )
  }
}

function parseJson(v: unknown): Json {
  if (v === null || v === undefined) return {}
  if (typeof v === 'object') return v as Json
  try {
    return JSON.parse(String(v)) as Json
  } catch {
    return {}
  }
}

export function canonicalEmail(raw: string): string {
  const trimmed = raw.trim().normalize('NFC')
  const at = trimmed.lastIndexOf('@')
  if (at === -1) throw AUTH_ERRORS.validationFailed('invalid email')
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1).toLowerCase()
  if (local.length === 0 || domain.length === 0 || !domain.includes('.')) {
    throw AUTH_ERRORS.validationFailed('invalid email')
  }
  return `${local}@${domain}`
}

function sanitizeMeta(data: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(data)) if (!PROTECTED_META_KEYS.has(k)) out[k] = v
  return out
}

function redactTraits(traits: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(traits)) {
    out[k] = /token|password|secret|key/i.test(k) ? '[redacted]' : v
  }
  return out
}

function parseDuration(d: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(d.trim())
  if (!m) return 0
  const n = Number(m[1])
  return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000)
}

export { AuthError }
