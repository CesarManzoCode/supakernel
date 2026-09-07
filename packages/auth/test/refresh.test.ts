import { sql } from '@supakernel/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authTable } from '../src/index.js'
import { type AuthHarness, makeAuthHarness } from './helpers/setup.js'

const T = authTable('refresh_tokens', 'sqlite')
const S = authTable('sessions', 'sqlite')

describe('refresh rotation / reuse / concurrency (contract §12.2, §12.3, RFC 9700)', () => {
  let h: AuthHarness
  let refreshToken: string

  beforeEach(async () => {
    h = await makeAuthHarness('sqlite')
    const up = await h.client().auth.signUp({ email: 'r@example.com', password: 'password123' })
    refreshToken = up.data.session?.refresh_token as string
  })
  afterEach(async () => {
    await h.adapter.close()
  })

  it('rotation: a refresh yields a new pair and the old token is marked used', async () => {
    const s = await h.service.refreshSession(refreshToken)
    expect(s.refresh_token).not.toBe(refreshToken)
    const rows = await h.adapter.execute(sql(`SELECT used FROM ${T} WHERE parent IS NULL`))
    expect(rows.rows[0]?.used).toBe(1)
  })

  it('replay inside the grace window returns exactly the same child', async () => {
    const first = await h.service.refreshSession(refreshToken)
    h.clock.advance(3000)
    const second = await h.service.refreshSession(refreshToken)
    expect(second.refresh_token).toBe(first.refresh_token)
    expect(second.access_token).toBe(first.access_token)
  })

  it('reuse outside the grace window revokes the whole family and every descendant session', async () => {
    const first = await h.service.refreshSession(refreshToken)
    await h.service.refreshSession(first.refresh_token)
    h.clock.advance(11_000)
    await expect(h.service.refreshSession(refreshToken)).rejects.toThrow(/reused|already used/i)

    const active = await h.adapter.execute(sql(`SELECT count(*) AS n FROM ${T} WHERE revoked = 0`))
    expect(Number(active.rows[0]?.n)).toBe(0)
    const sessions = await h.adapter.execute(
      sql(`SELECT count(*) AS n FROM ${S} WHERE not_after IS NULL`),
    )
    expect(Number(sessions.rows[0]?.n)).toBe(0)
  })

  it('concurrent refresh of the same token: never two distinct active children', async () => {
    const results = await Promise.allSettled([
      h.service.refreshSession(refreshToken),
      h.service.refreshSession(refreshToken),
      h.service.refreshSession(refreshToken),
    ])
    const children = new Set(
      results
        .filter(
          (r): r is PromiseFulfilledResult<{ refresh_token: string }> => r.status === 'fulfilled',
        )
        .map((r) => r.value.refresh_token),
    )
    expect(children.size).toBeLessThanOrEqual(1)
    const activeChildren = await h.adapter.execute(
      sql(`SELECT count(*) AS n FROM ${T} WHERE parent IS NOT NULL AND revoked = 0 AND used = 0`),
    )
    expect(Number(activeChildren.rows[0]?.n)).toBeLessThanOrEqual(1)
  })

  it('a revoked access token loses access even with a valid signature', async () => {
    const login = await h
      .client()
      .auth.signInWithPassword({ email: 'r@example.com', password: 'password123' })
    const token = login.data.session?.access_token as string
    const hdr = { apikey: h.service.apiKeys.publishable, authorization: `Bearer ${token}` }
    expect((await h.raw('/auth/v1/user', { headers: hdr })).status).toBe(200)
    await h.service.signOut(token, 'global')
    expect((await h.raw('/auth/v1/user', { headers: hdr })).status).toBe(401)
  })
})
