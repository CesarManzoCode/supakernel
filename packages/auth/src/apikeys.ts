import { bytesToBase64Url } from '@supakernel/contracts'
import type { CryptoPort } from '@supakernel/ports'
import type { AuthConfig } from './config.js'
import type { AuthDb } from './db.js'
import { authTable } from './schema.js'

export interface ApiKeyPair {
  readonly publishable: string
  readonly secret: string
}

export interface ResolvedApiKey {
  readonly type: 'publishable' | 'secret'
  readonly role: 'anon' | 'service_role'
}

function rand(n: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(n)))
}

/**
 * Mint the project key pair (contract §12.2). `sb_publishable_*` identifies the project and
 * yields an `anon` principal; `sb_secret_*` is stored only as an HMAC hash and yields a
 * `service_role` principal — and only when presented as the `apikey`, never `Authorization`.
 */
export async function mintApiKeys(
  db: AuthDb,
  crypto: CryptoPort,
  config: AuthConfig,
): Promise<ApiKeyPair> {
  const T = authTable('api_keys', db.family)
  const now = new Date().toISOString()
  const publishable = `sb_publishable_${config.projectRef}_${rand(18)}`
  const secret = `sb_secret_${config.projectRef}_${rand(24)}`

  await db.run(`DELETE FROM ${T}`)
  await db.run(
    `INSERT INTO ${T} (id, key_prefix, description, hash, type, role, created_at) VALUES (?,?,?,?,?,?,?)`,
    [
      globalThis.crypto.randomUUID(),
      publishable,
      'default publishable',
      publishable,
      'publishable',
      'anon',
      now,
    ],
  )
  await db.run(
    `INSERT INTO ${T} (id, key_prefix, description, hash, type, role, created_at) VALUES (?,?,?,?,?,?,?)`,
    [
      globalThis.crypto.randomUUID(),
      secret.slice(0, secret.lastIndexOf('_')),
      'default secret',
      await crypto.hmacSha256(config.serverSecret, secret),
      'secret',
      'service_role',
      now,
    ],
  )
  return { publishable, secret }
}

export async function resolveApiKey(
  db: AuthDb,
  crypto: CryptoPort,
  config: AuthConfig,
  presented: string,
): Promise<ResolvedApiKey | null> {
  const T = authTable('api_keys', db.family)
  if (presented.startsWith('sb_secret_')) {
    const hash = await crypto.hmacSha256(config.serverSecret, presented)
    const row = await db.one(`SELECT role FROM ${T} WHERE type = 'secret' AND hash = ?`, [hash])
    return row ? { type: 'secret', role: 'service_role' } : null
  }
  if (presented.startsWith('sb_publishable_')) {
    const row = await db.one(`SELECT role FROM ${T} WHERE type = 'publishable' AND hash = ?`, [
      presented,
    ])
    return row ? { type: 'publishable', role: 'anon' } : null
  }
  return null
}
