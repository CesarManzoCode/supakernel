import type { Family } from '@supakernel/contracts'

/**
 * Portable DDL for the canonical Auth state (contract §12.2). PostgreSQL keeps the tables in an
 * `auth` schema (upgrade path to Supabase); the SQLite family flattens them to `auth_*` in the
 * default schema. Types stay in the portable set.
 */
export const AUTH_TABLES = [
  'users',
  'identities',
  'sessions',
  'refresh_tokens',
  'refresh_replay',
  'one_time_tokens',
  'audit_log',
  'signing_keys',
  'api_keys',
] as const

export function authTable(name: (typeof AUTH_TABLES)[number], family: Family): string {
  return family === 'postgres' ? `auth.${name}` : `auth_${name}`
}

export function authSchemaStatements(family: Family): string[] {
  const pg = family === 'postgres'
  const T = (n: (typeof AUTH_TABLES)[number]): string => authTable(n, family)
  const ts = pg ? 'timestamptz' : 'TEXT'
  const json = pg ? 'jsonb' : 'TEXT'
  const bool = pg ? 'boolean' : 'INTEGER'
  const txt = pg ? 'text' : 'TEXT'
  const emptyJson = pg ? "'{}'::jsonb" : "'{}'"
  const falseVal = pg ? 'false' : '0'
  const out: string[] = []
  if (pg) out.push('CREATE SCHEMA IF NOT EXISTS auth')
  for (const n of [...AUTH_TABLES].reverse()) out.push(`DROP TABLE IF EXISTS ${T(n)}`)

  out.push(`CREATE TABLE ${T('users')} (
    id ${txt} PRIMARY KEY,
    email ${txt} UNIQUE,
    encrypted_password ${txt},
    email_confirmed_at ${ts},
    last_sign_in_at ${ts},
    role ${txt} NOT NULL DEFAULT 'authenticated',
    aud ${txt} NOT NULL DEFAULT 'authenticated',
    is_super_admin ${bool} NOT NULL DEFAULT ${falseVal},
    is_anonymous ${bool} NOT NULL DEFAULT ${falseVal},
    is_sso_user ${bool} NOT NULL DEFAULT ${falseVal},
    banned_until ${ts},
    tenant_id ${txt},
    raw_app_meta_data ${json} NOT NULL DEFAULT ${emptyJson},
    raw_user_meta_data ${json} NOT NULL DEFAULT ${emptyJson},
    email_change ${txt},
    created_at ${ts} NOT NULL,
    updated_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('identities')} (
    id ${txt} PRIMARY KEY,
    user_id ${txt} NOT NULL REFERENCES ${T('users')}(id) ON DELETE CASCADE,
    provider ${txt} NOT NULL DEFAULT 'email',
    provider_id ${txt} NOT NULL,
    identity_data ${json} NOT NULL DEFAULT ${emptyJson},
    last_sign_in_at ${ts},
    created_at ${ts} NOT NULL,
    updated_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('sessions')} (
    id ${txt} PRIMARY KEY,
    user_id ${txt} NOT NULL REFERENCES ${T('users')}(id) ON DELETE CASCADE,
    not_after ${ts},
    refreshed_at ${ts},
    user_agent ${txt},
    ip ${txt},
    created_at ${ts} NOT NULL,
    updated_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('refresh_tokens')} (
    token_hash ${txt} PRIMARY KEY,
    session_id ${txt} NOT NULL REFERENCES ${T('sessions')}(id) ON DELETE CASCADE,
    user_id ${txt} NOT NULL,
    parent ${txt},
    family_id ${txt} NOT NULL,
    revoked ${bool} NOT NULL DEFAULT ${falseVal},
    used ${bool} NOT NULL DEFAULT ${falseVal},
    created_at ${ts} NOT NULL,
    updated_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('refresh_replay')} (
    parent_hash ${txt} PRIMARY KEY,
    child_token ${txt} NOT NULL,
    access_token ${txt} NOT NULL,
    expires_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('one_time_tokens')} (
    id ${txt} PRIMARY KEY,
    user_id ${txt} NOT NULL REFERENCES ${T('users')}(id) ON DELETE CASCADE,
    token_type ${txt} NOT NULL,
    token_hash ${txt} NOT NULL,
    relates_to ${txt} NOT NULL,
    created_at ${ts} NOT NULL,
    expires_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('audit_log')} (
    id ${txt} PRIMARY KEY,
    action ${txt} NOT NULL,
    actor_id ${txt},
    actor_ip ${txt},
    traits ${json} NOT NULL DEFAULT ${emptyJson},
    created_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('signing_keys')} (
    kid ${txt} PRIMARY KEY,
    alg ${txt} NOT NULL,
    status ${txt} NOT NULL,
    private_jwk ${json} NOT NULL,
    public_jwk ${json} NOT NULL,
    created_at ${ts} NOT NULL
  )`)

  out.push(`CREATE TABLE ${T('api_keys')} (
    id ${txt} PRIMARY KEY,
    key_prefix ${txt} NOT NULL,
    description ${txt},
    hash ${txt},
    type ${txt} NOT NULL,
    role ${txt} NOT NULL,
    created_at ${ts} NOT NULL
  )`)

  return out
}
