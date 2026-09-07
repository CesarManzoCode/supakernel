import { sql } from '@supakernel/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authTable, canonicalEmail } from '../src/index.js'
import { type AuthHarness, makeAuthHarness } from './helpers/setup.js'

function bearer(h: AuthHarness, token: string): Record<string, string> {
  return { apikey: h.service.apiKeys.publishable, authorization: `Bearer ${token}` }
}

describe('Auth security (contract §12.2, §12.3, §13.2)', () => {
  let h: AuthHarness
  beforeEach(async () => {
    h = await makeAuthHarness('sqlite')
  })
  afterEach(async () => {
    await h.adapter.close()
  })

  async function seeded(): Promise<{ access_token: string; refresh_token: string; id: string }> {
    const up = await h.client().auth.signUp({ email: 's@example.com', password: 'password123' })
    return {
      access_token: up.data.session?.access_token as string,
      refresh_token: up.data.session?.refresh_token as string,
      id: up.data.user?.id as string,
    }
  }

  it('rejects alg=none, expired, tampered payload, and a foreign-project token', async () => {
    const s = await seeded()
    const [header, payload, signature] = s.access_token.split('.')
    const kid = JSON.parse(Buffer.from(header as string, 'base64url').toString()).kid
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString())

    const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', kid })).toString('base64url')}.${payload}.`
    expect((await h.raw('/auth/v1/user', { headers: bearer(h, noneToken) })).status).toBe(401)

    h.clock.advance(4_000_000)
    expect((await h.raw('/auth/v1/user', { headers: bearer(h, s.access_token) })).status).toBe(401)
    h.clock.set(Date.parse('2026-09-06T12:00:00.000Z'))

    const tampered = `${header}.${Buffer.from(JSON.stringify({ ...claims, role: 'service_role' })).toString('base64url')}.${signature}`
    expect((await h.raw('/auth/v1/user', { headers: bearer(h, tampered) })).status).toBe(401)

    const other = await makeAuthHarness('sqlite')
    const foreign = (
      await other.client().auth.signUp({ email: 'f@example.com', password: 'password123' })
    ).data.session?.access_token as string
    expect((await h.raw('/auth/v1/user', { headers: bearer(h, foreign) })).status).toBe(401)
    await other.adapter.close()
  })

  it('mass assignment: signup data cannot set role, tenant_id, is_super_admin', async () => {
    const up = await h.client().auth.signUp({
      email: 'ma@example.com',
      password: 'password123',
      options: {
        data: { role: 'service_role', tenant_id: 'evil', is_super_admin: true, nickname: 'ok' },
      },
    })
    const uid = up.data.user?.id as string
    const row = await h.adapter.execute(
      sql(
        `SELECT role, is_super_admin, tenant_id, raw_user_meta_data FROM ${authTable('users', 'sqlite')} WHERE id = '${uid}'`,
      ),
    )
    expect(row.rows[0]?.role).toBe('authenticated')
    expect(row.rows[0]?.is_super_admin).toBe(0)
    expect(row.rows[0]?.tenant_id).toBeNull()
    const meta = JSON.parse(String(row.rows[0]?.raw_user_meta_data))
    expect(meta.nickname).toBe('ok')
    expect(meta.role).toBeUndefined()
  })

  it('a secret in Authorization only does not elevate; a user token does not become service', async () => {
    const s = await seeded()
    const p = await h.service.resolvePrincipal(
      new Headers({
        apikey: h.service.apiKeys.publishable,
        authorization: `Bearer ${s.access_token}`,
      }),
    )
    expect(p.role).toBe('authenticated')
    expect(p.credentialSource).toBe('jwt')
    const p2 = await h.service.resolvePrincipal(
      new Headers({
        apikey: h.service.apiKeys.publishable,
        authorization: `Bearer ${h.service.apiKeys.secret}`,
      }),
    )
    expect(p2.role).toBe('anon')
  })

  it('unknown / forged apikey is rejected', async () => {
    expect(
      (
        await h.raw('/auth/v1/user', {
          headers: { apikey: 'sb_publishable_demo_forged', authorization: 'Bearer x' },
        })
      ).status,
    ).toBe(401)
  })

  it('state machine: revocation is irreversible', async () => {
    const s = await seeded()
    await h.service.signOut(s.access_token, 'global')
    await expect(h.service.refreshSession(s.refresh_token)).rejects.toThrow()
    expect((await h.raw('/auth/v1/user', { headers: bearer(h, s.access_token) })).status).toBe(401)
  })

  it('email canonicalization: NFC + lowercase domain, local part preserved', () => {
    expect(canonicalEmail('  User.Name+tag@EXAMPLE.com ')).toBe('User.Name+tag@example.com')
    expect(() => canonicalEmail('nope')).toThrow()
  })

  it('at most one active refresh child across a chain', async () => {
    const s = await seeded()
    let rt = s.refresh_token
    for (let i = 0; i < 5; i++) rt = (await h.service.refreshSession(rt)).refresh_token
    const active = await h.adapter.execute(
      sql(
        `SELECT count(*) AS n FROM ${authTable('refresh_tokens', 'sqlite')} WHERE revoked = 0 AND used = 0`,
      ),
    )
    expect(Number(active.rows[0]?.n)).toBe(1)
  })
})
