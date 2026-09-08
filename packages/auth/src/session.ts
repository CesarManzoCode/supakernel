import type { Transaction } from '@supakernel/contracts'
import type { CryptoPort } from '@supakernel/ports'
import { NULL_FAULT_PORT } from '@supakernel/ports'
import type { AuthConfig, AuthPorts } from './config.js'
import { type AuthDb, boolValue, readBool } from './db.js'
import { AUTH_ERRORS } from './errors.js'
import { authTable } from './schema.js'
import { hashToken, randomToken } from './tokens.js'

export interface IssuedTokens {
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_in: number
  readonly expires_at: number
  readonly sessionId: string
}

export interface SessionDeps {
  readonly db: AuthDb
  readonly crypto: CryptoPort
  readonly ports: AuthPorts
  readonly config: AuthConfig
  buildAccessClaims(userId: string, sessionId: string): Promise<Readonly<Record<string, unknown>>>
  activeKid(): string
}

const T = (n: Parameters<typeof authTable>[0], d: SessionDeps): string => authTable(n, d.db.family)

/** Create a session + its first refresh token + an access token (contract §12.2). */
export async function issueSession(
  d: SessionDeps,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<IssuedTokens> {
  const now = d.ports.clock.now()
  const sessionId = d.ports.random.uuidV4()
  const familyId = d.ports.random.uuidV4()

  await d.db.run(
    `INSERT INTO ${T('sessions', d)} (id, user_id, refreshed_at, ip, user_agent, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    [sessionId, userId, now, meta.ip ?? null, meta.userAgent ?? null, now, now],
  )
  const refresh_token = randomToken(d.ports.random)
  await d.db.run(
    `INSERT INTO ${T('refresh_tokens', d)} (token_hash, session_id, user_id, parent, family_id, revoked, used, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      await hashToken(d.crypto, refresh_token),
      sessionId,
      userId,
      null,
      familyId,
      boolValue(d.db.family, false),
      boolValue(d.db.family, false),
      now,
      now,
    ],
  )
  return mintAccess(d, userId, sessionId, refresh_token)
}

async function mintAccess(
  d: SessionDeps,
  userId: string,
  sessionId: string,
  refresh_token: string,
): Promise<IssuedTokens> {
  const iat = Math.floor(d.ports.clock.epochMillis() / 1000)
  const exp = iat + d.config.accessTokenTtlSeconds
  const claims = {
    ...(await d.buildAccessClaims(userId, sessionId)),
    iat,
    exp,
    iss: d.config.issuer,
    aud: d.config.audience,
    session_id: sessionId,
  }
  const access_token = await d.crypto.signJwt(claims, d.activeKid())
  return {
    access_token,
    refresh_token,
    expires_in: d.config.accessTokenTtlSeconds,
    expires_at: exp,
    sessionId,
  }
}

interface CachedChild {
  child_token: unknown
  access_token: unknown
  expires_at: unknown
}

function fromCache(d: SessionDeps, cached: CachedChild, sessionId: string): IssuedTokens {
  return {
    access_token: String(cached.access_token),
    refresh_token: String(cached.child_token),
    expires_in: d.config.accessTokenTtlSeconds,
    expires_at: Math.floor(d.ports.clock.epochMillis() / 1000) + d.config.accessTokenTtlSeconds,
    sessionId,
  }
}

/**
 * Rotate a refresh token (contract §12.2, RFC 9700):
 * - active token → CAS `active→used` + insert child atomically, cache the child for the grace window;
 * - a used token replayed **inside** the grace window → return exactly the same cached child;
 * - a used/revoked token **outside** the window → revoke the whole family + descendant sessions
 *   (the revocation MUST commit — the error is thrown after the transaction).
 */
export async function rotateRefresh(d: SessionDeps, presented: string): Promise<IssuedTokens> {
  const hash = await hashToken(d.crypto, presented)
  type Outcome = { kind: 'ok'; tokens: IssuedTokens } | { kind: 'reused' } | { kind: 'not_found' }

  const outcome: Outcome = await d.db.tx(async (tx): Promise<Outcome> => {
    const row = await d.db.one(
      `SELECT token_hash, session_id, user_id, family_id, revoked, used FROM ${T('refresh_tokens', d)} WHERE token_hash = ?`,
      [hash],
      tx,
    )
    if (!row) return { kind: 'not_found' }
    const now = d.ports.clock.now()
    const nowMs = d.ports.clock.epochMillis()

    const replay = async (): Promise<CachedChild | null> =>
      d.db.one(
        `SELECT child_token, access_token, expires_at FROM ${T('refresh_replay', d)} WHERE parent_hash = ?`,
        [hash],
        tx,
      ) as Promise<CachedChild | null>

    if (readBool(row.revoked) || readBool(row.used)) {
      const cached = await replay()
      if (cached && Date.parse(String(cached.expires_at)) > nowMs) {
        return { kind: 'ok', tokens: fromCache(d, cached, String(row.session_id)) }
      }
      await revokeFamily(d, tx, String(row.family_id))
      return { kind: 'reused' }
    }

    const affected = await d.db.run(
      `UPDATE ${T('refresh_tokens', d)} SET used = ?, updated_at = ? WHERE token_hash = ? AND used = ? AND revoked = ?`,
      [
        boolValue(d.db.family, true),
        now,
        hash,
        boolValue(d.db.family, false),
        boolValue(d.db.family, false),
      ],
      tx,
    )
    if (affected !== 1) {
      const cached = await replay()
      if (cached && Date.parse(String(cached.expires_at)) > nowMs) {
        return { kind: 'ok', tokens: fromCache(d, cached, String(row.session_id)) }
      }
      await revokeFamily(d, tx, String(row.family_id))
      return { kind: 'reused' }
    }
    await (d.ports.fault ?? NULL_FAULT_PORT).hit('auth.after_parent_cas', {
      session: String(row.session_id),
    })

    const child = randomToken(d.ports.random)
    await d.db.run(
      `INSERT INTO ${T('refresh_tokens', d)} (token_hash, session_id, user_id, parent, family_id, revoked, used, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        await hashToken(d.crypto, child),
        String(row.session_id),
        String(row.user_id),
        hash,
        String(row.family_id),
        boolValue(d.db.family, false),
        boolValue(d.db.family, false),
        now,
        now,
      ],
      tx,
    )
    await (d.ports.fault ?? NULL_FAULT_PORT).hit('auth.after_child_insert', {
      session: String(row.session_id),
    })
    await d.db.run(
      `UPDATE ${T('sessions', d)} SET refreshed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, String(row.session_id)],
      tx,
    )
    const minted = await mintAccess(d, String(row.user_id), String(row.session_id), child)
    const graceExpiry = new Date(nowMs + d.config.refreshGraceSeconds * 1000).toISOString()
    await d.db.run(
      `INSERT INTO ${T('refresh_replay', d)} (parent_hash, child_token, access_token, expires_at) VALUES (?,?,?,?)`,
      [hash, child, minted.access_token, graceExpiry],
      tx,
    )
    return { kind: 'ok', tokens: minted }
  })

  // The transaction has committed here — a fault now must NOT lose the rotation (contract §22:
  // "commit sin response puede requerir idempotency key/retry y jamás duplica").
  await (d.ports.fault ?? NULL_FAULT_PORT).hit('auth.after_commit_before_response', {})

  if (outcome.kind === 'not_found') throw AUTH_ERRORS.refreshTokenNotFound()
  if (outcome.kind === 'reused') throw AUTH_ERRORS.refreshTokenReused()
  return outcome.tokens
}

async function revokeFamily(d: SessionDeps, tx: Transaction, familyId: string): Promise<void> {
  const now = d.ports.clock.now()
  await d.db.run(
    `UPDATE ${T('refresh_tokens', d)} SET revoked = ?, updated_at = ? WHERE family_id = ?`,
    [boolValue(d.db.family, true), now, familyId],
    tx,
  )
  const sessions = await d.db.all(
    `SELECT DISTINCT session_id FROM ${T('refresh_tokens', d)} WHERE family_id = ?`,
    [familyId],
    tx,
  )
  for (const s of sessions) {
    await d.db.run(
      `UPDATE ${T('sessions', d)} SET not_after = ?, updated_at = ? WHERE id = ?`,
      [now, now, String(s.session_id)],
      tx,
    )
  }
}

/** Revoke sessions per logout scope (contract §12.2). */
export async function revokeSessions(
  d: SessionDeps,
  userId: string,
  currentSessionId: string | null,
  scope: 'local' | 'global' | 'others',
): Promise<void> {
  const now = d.ports.clock.now()
  const targets = await d.db.all(`SELECT id FROM ${T('sessions', d)} WHERE user_id = ?`, [userId])
  for (const row of targets) {
    const id = String(row.id)
    if (scope === 'local' && id !== currentSessionId) continue
    if (scope === 'others' && id === currentSessionId) continue
    await d.db.run(`UPDATE ${T('sessions', d)} SET not_after = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ])
    await d.db.run(
      `UPDATE ${T('refresh_tokens', d)} SET revoked = ?, updated_at = ? WHERE session_id = ?`,
      [boolValue(d.db.family, true), now, id],
    )
  }
}

/** Whether a session is still active (contract §12.2 — a revoked access token loses access). */
export async function sessionActive(d: SessionDeps, sessionId: string): Promise<boolean> {
  const row = await d.db.one(`SELECT not_after FROM ${T('sessions', d)} WHERE id = ?`, [sessionId])
  if (!row) return false
  if (row.not_after === null || row.not_after === undefined) return true
  return Date.parse(String(row.not_after)) > d.ports.clock.epochMillis()
}
