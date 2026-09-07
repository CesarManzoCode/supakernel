import { describe, expect, it } from 'vitest'
import {
  createWebCryptoPort,
  generateSigningKey,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/crypto/index.js'

describe('password hashing (contract §12.2)', () => {
  it('PBKDF2-HMAC-SHA256, 600k iterations, versioned envelope', async () => {
    const env = await hashPassword('correct horse battery staple')
    expect(env).toMatch(/^sk-pbkdf2-sha256\$v=1\$i=600000\$[^$]+\$[^$]+$/)
    expect(await verifyPassword('correct horse battery staple', env)).toBe(true)
    expect(await verifyPassword('wrong', env)).toBe(false)
  })

  it('salts are unique per hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('needsRehash flags a weaker work factor', () => {
    expect(needsRehash('sk-pbkdf2-sha256$v=1$i=100000$x$y')).toBe(true)
    expect(needsRehash('sk-pbkdf2-sha256$v=1$i=600000$x$y')).toBe(false)
  })
})

describe('ES256 JWT (contract §12.2 — no alg confusion)', () => {
  it('signs with the active kid and verifies issuer/audience', async () => {
    const port = await createWebCryptoPort([await generateSigningKey('kid-1')])
    const token = await port.signJwt(
      {
        sub: 'user-1',
        role: 'authenticated',
        iss: 'https://sk',
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      port.keyring.activeKeyId,
    )
    const ok = await port.verifyJwt(token, {
      issuer: 'https://sk',
      audience: 'authenticated',
      algorithms: ['ES256'],
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.claims.sub).toBe('user-1')
  })

  it('rejects alg=none, wrong audience, wrong issuer, expired, unknown kid', async () => {
    const port = await createWebCryptoPort([await generateSigningKey('kid-1')])
    const base = {
      sub: 'u',
      iss: 'https://sk',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 60,
    }
    const good = await port.signJwt(base, 'kid-1')

    expect(
      (
        await port.verifyJwt(good, {
          issuer: 'https://sk',
          audience: 'other',
          algorithms: ['ES256'],
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await port.verifyJwt(good, {
          issuer: 'https://evil',
          audience: 'authenticated',
          algorithms: ['ES256'],
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await port.verifyJwt(good, {
          issuer: 'https://sk',
          audience: 'authenticated',
          algorithms: ['RS256'],
        })
      ).ok,
    ).toBe(false)

    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: 'kid-1' })).toString(
      'base64url',
    )
    const noneBody = Buffer.from(JSON.stringify(base)).toString('base64url')
    const r = await port.verifyJwt(`${noneHeader}.${noneBody}.`, {
      issuer: 'https://sk',
      audience: 'authenticated',
      algorithms: ['ES256'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('alg')

    const expired = await port.signJwt(
      { ...base, exp: Math.floor(Date.now() / 1000) - 10 },
      'kid-1',
    )
    const er = await port.verifyJwt(expired, {
      issuer: 'https://sk',
      audience: 'authenticated',
      algorithms: ['ES256'],
    })
    expect(er.ok).toBe(false)
    if (!er.ok) expect(er.reason).toBe('expired')
  })

  it('a token signed by a foreign key claiming a known kid fails signature', async () => {
    const realPort = await createWebCryptoPort([await generateSigningKey('kid-1')])
    const foreignPort = await createWebCryptoPort([await generateSigningKey('kid-1')])
    const forged = await foreignPort.signJwt(
      {
        sub: 'attacker',
        iss: 'https://sk',
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      'kid-1',
    )
    const r = await realPort.verifyJwt(forged, {
      issuer: 'https://sk',
      audience: 'authenticated',
      algorithms: ['ES256'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('signature')
  })
})
