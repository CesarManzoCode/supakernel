import { sql } from '@supakernel/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authTable } from '../src/index.js'
import { type AuthHarness, makeAuthHarness } from './helpers/setup.js'

const pub = (h: AuthHarness): string => h.service.apiKeys.publishable
const bearer = (h: AuthHarness, token: string | undefined): Record<string, string> => ({
  apikey: pub(h),
  authorization: `Bearer ${token}`,
})

/** Shared Auth behavioural suite, run against both database families (contract §12, §30 L6). */
export function describeAuth(family: 'postgres' | 'sqlite'): void {
  describe(`Auth / GoTrue subset — ${family}, real supabase-js (contract §12)`, () => {
    let h: AuthHarness
    beforeAll(async () => {
      h = await makeAuthHarness(family)
    })
    afterAll(async () => {
      await h.adapter.close()
    })

    it('signup (auto-confirm) → session; getUser via access token', async () => {
      const up = await h
        .client()
        .auth.signUp({ email: `A+${family}@Example.COM`, password: 'password123' })
      expect(up.error).toBeNull()
      expect(up.data.session?.access_token).toBeTruthy()
      expect(up.data.user?.email).toBe(`A+${family}@example.com`)

      const me = await h.raw('/auth/v1/user', { headers: bearer(h, up.data.session?.access_token) })
      expect(me.status).toBe(200)
      expect((await me.json()).id).toBe(up.data.user?.id)
    })

    it('duplicate signup is rejected', async () => {
      await h.client().auth.signUp({ email: `dup${family}@example.com`, password: 'password123' })
      const again = await h
        .client()
        .auth.signUp({ email: `dup${family}@example.com`, password: 'password123' })
      expect(again.error).not.toBeNull()
    })

    it('password login: correct works, wrong fails, no enumeration difference on recover', async () => {
      await h.client().auth.signUp({ email: `login${family}@example.com`, password: 'password123' })
      expect(
        (
          await h.client().auth.signInWithPassword({
            email: `login${family}@example.com`,
            password: 'password123',
          })
        ).data.session,
      ).toBeTruthy()
      expect(
        (
          await h
            .client()
            .auth.signInWithPassword({ email: `login${family}@example.com`, password: 'nope' })
        ).error,
      ).not.toBeNull()

      const recoverBody = (email: string) => ({
        method: 'POST',
        headers: { apikey: pub(h), 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const r1 = await h.raw('/auth/v1/recover', recoverBody(`login${family}@example.com`))
      const r2 = await h.raw('/auth/v1/recover', recoverBody(`ghost${family}@example.com`))
      expect(r1.status).toBe(r2.status)
    })

    it('updateUser: password change revokes other sessions; metadata cannot set role', async () => {
      const email = `multi${family}@example.com`
      await h.client().auth.signUp({ email, password: 'password123' })
      const s1 = (await h.client().auth.signInWithPassword({ email, password: 'password123' })).data
        .session
      const s2 = (await h.client().auth.signInWithPassword({ email, password: 'password123' })).data
        .session

      const upd = await h.raw('/auth/v1/user', {
        method: 'PUT',
        headers: { ...bearer(h, s1?.access_token), 'content-type': 'application/json' },
        body: JSON.stringify({
          password: 'newpassword123',
          data: { nickname: 'ace', role: 'service_role', is_super_admin: true },
        }),
      })
      expect(upd.status).toBe(200)
      const body = await upd.json()
      expect(body.user_metadata.nickname).toBe('ace')
      expect(body.user_metadata.role).toBeUndefined()
      expect(body.role).toBe('authenticated')

      expect((await h.raw('/auth/v1/user', { headers: bearer(h, s2?.access_token) })).status).toBe(
        401,
      )
      expect((await h.raw('/auth/v1/user', { headers: bearer(h, s1?.access_token) })).status).toBe(
        200,
      )
    })

    it('logout scopes: others / global', async () => {
      const email = `logout${family}@example.com`
      await h.client().auth.signUp({ email, password: 'password123' })
      const s1 = (await h.client().auth.signInWithPassword({ email, password: 'password123' })).data
        .session
      const s2 = (await h.client().auth.signInWithPassword({ email, password: 'password123' })).data
        .session
      const s3 = (await h.client().auth.signInWithPassword({ email, password: 'password123' })).data
        .session

      await h.raw('/auth/v1/logout?scope=others', {
        method: 'POST',
        headers: bearer(h, s1?.access_token),
      })
      expect((await h.raw('/auth/v1/user', { headers: bearer(h, s1?.access_token) })).status).toBe(
        200,
      )
      expect((await h.raw('/auth/v1/user', { headers: bearer(h, s2?.access_token) })).status).toBe(
        401,
      )
      expect((await h.raw('/auth/v1/user', { headers: bearer(h, s3?.access_token) })).status).toBe(
        401,
      )

      await h.raw('/auth/v1/logout?scope=global', {
        method: 'POST',
        headers: bearer(h, s1?.access_token),
      })
      expect((await h.raw('/auth/v1/user', { headers: bearer(h, s1?.access_token) })).status).toBe(
        401,
      )
    })

    it('service role only via the secret key as apikey — not Authorization', async () => {
      expect(
        (
          await h.raw('/auth/v1/admin/users', {
            headers: { authorization: `Bearer ${h.service.apiKeys.secret}` },
          })
        ).status,
      ).toBe(401)
      expect(
        (await h.raw('/auth/v1/admin/users', { headers: { apikey: h.service.apiKeys.secret } }))
          .status,
      ).toBe(200)
      expect((await h.raw('/auth/v1/admin/users', { headers: { apikey: pub(h) } })).status).toBe(
        403,
      )
    })

    it('admin user CRUD (secret only)', async () => {
      const admin = h.admin()
      const created = await admin.auth.admin.createUser({
        email: `adm${family}@example.com`,
        password: 'password123',
        email_confirm: true,
        user_metadata: { plan: 'pro' },
      })
      expect(created.error).toBeNull()
      const id = created.data.user?.id as string
      expect((await admin.auth.admin.getUserById(id)).data.user?.email).toBe(
        `adm${family}@example.com`,
      )
      expect((await admin.auth.admin.listUsers()).data.users.length).toBeGreaterThan(0)
      const upd = await admin.auth.admin.updateUserById(id, {
        user_metadata: { plan: 'enterprise' },
      })
      expect((upd.data.user?.user_metadata as { plan?: string } | undefined)?.plan).toBe(
        'enterprise',
      )
      expect((await admin.auth.admin.deleteUser(id)).error).toBeNull()
    })

    it('recover → verify(recovery) issues a session', async () => {
      const email = `rec${family}@example.com`
      await h.client().auth.signUp({ email, password: 'password123' })
      h.mail.clear()
      await h.raw('/auth/v1/recover', {
        method: 'POST',
        headers: { apikey: pub(h), 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const token = h.mail.sent.at(-1)?.variables.token as string
      expect(token).toBeTruthy()
      const verified = await h.raw('/auth/v1/verify', {
        method: 'POST',
        headers: { apikey: pub(h), 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'recovery', token }),
      })
      expect(verified.status).toBe(200)
      expect((await verified.json()).access_token).toBeTruthy()
    })

    it('settings / health / JWKS', async () => {
      expect((await (await h.raw('/auth/v1/settings')).json()).external.email).toBe(true)
      expect((await (await h.raw('/auth/v1/health')).json()).healthy).toBe(true)
      const jwks = await (await h.raw('/auth/v1/.well-known/jwks.json')).json()
      expect(jwks.keys[0].kty).toBe('EC')
      expect(jwks.keys[0].alg).toBe('ES256')
    })

    it('audit log is written and never records a secret', async () => {
      const rows = await h.adapter.execute(
        sql(`SELECT action, traits FROM ${authTable('audit_log', family)}`),
      )
      expect(rows.rows.length).toBeGreaterThan(0)
      expect(JSON.stringify(rows.rows)).not.toMatch(/password123|sb_secret_/)
    })
  })
}
