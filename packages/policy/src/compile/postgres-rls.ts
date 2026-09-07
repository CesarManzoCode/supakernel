import {
  assertNever,
  type Expr,
  type PolicyRule,
  type SchemaIR,
  type SqlStatement,
} from '@supakernel/contracts'

/**
 * Compile the PolicyIR to **native PostgreSQL row-level security** (contract §13.1).
 *
 * The runtime does not filter rows for Postgres: every authenticated request runs in a
 * transaction that does `SET LOCAL ROLE <role>` and `SELECT set_config('sk.*', …, true)` for
 * the verified claims, and the database enforces the `CREATE POLICY` statements emitted here.
 * A direct-SQL test (see `test/postgres-direct.test.ts`) sets the same GUCs under `SET ROLE`
 * and proves enforcement without SupaKernel in the loop.
 *
 * Only `select` / `insert` / `update` / `delete` map to `CREATE POLICY`; `subscribe` and the
 * `storage.*` actions are virtual resources enforced by `buildSecurityPlan`.
 */
export const SK_ROLES = ['anon', 'authenticated', 'service_role'] as const

const SQL_ACTION: Record<string, 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | null> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  subscribe: null,
  'storage.read': null,
  'storage.write': null,
}

function q(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error(`unsafe identifier: ${id}`)
  return `"${id}"`
}

/** Idempotent role + helper-schema bootstrap. Safe to run before every deploy. */
export function bootstrapStatements(): SqlStatement[] {
  const roleDo = SK_ROLES.map(
    (r) =>
      `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${q(r)} NOLOGIN; END IF;`,
  ).join('\n    ')
  return [
    { text: `DO $$ BEGIN\n    ${roleDo}\n  END $$`, parameters: [] },
    // `service_role` bypasses RLS at the database level; the app layer only ever assigns this
    // role when the credential is a verified secret key (contract §9.2, §12.2).
    { text: 'ALTER ROLE "service_role" BYPASSRLS', parameters: [] },
    { text: 'CREATE SCHEMA IF NOT EXISTS sk', parameters: [] },
    { text: 'GRANT USAGE ON SCHEMA sk TO "anon", "authenticated", "service_role"', parameters: [] },
    {
      text: `CREATE OR REPLACE FUNCTION sk.claims() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('sk.claims', true), ''), '{}')::jsonb $$`,
      parameters: [],
    },
    {
      text: `CREATE OR REPLACE FUNCTION sk.claim(VARIADIC path text[]) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT sk.claims() #>> path $$`,
      parameters: [],
    },
    {
      text: `CREATE OR REPLACE FUNCTION sk.subject_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('sk.subject_id', true), '') $$`,
      parameters: [],
    },
    {
      text: `CREATE OR REPLACE FUNCTION sk.tenant_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('sk.tenant_id', true), '') $$`,
      parameters: [],
    },
    {
      text: `CREATE OR REPLACE FUNCTION sk.jwt_role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('sk.role', true), '') $$`,
      parameters: [],
    },
  ]
}

/** GUC keys set per request (or per direct-SQL test) to carry the verified principal. */
export function principalGucs(principal: {
  subjectId: string | null
  tenantId: string
  role: string
  claims: Readonly<Record<string, unknown>>
}): Record<string, string> {
  return {
    'sk.subject_id': principal.subjectId ?? '',
    'sk.tenant_id': principal.tenantId,
    'sk.role': principal.role,
    'sk.claims': JSON.stringify(principal.claims ?? {}),
  }
}

export function compilePostgresRls(schema: SchemaIR, rules: readonly PolicyRule[]): SqlStatement[] {
  const out: SqlStatement[] = [...bootstrapStatements()]
  const rlsTables = new Set(
    rules.map((r) => r.table).filter((t) => schema.tables.some((x) => x.name === t)),
  )

  // Any project-defined role named in a policy (beyond anon/authenticated/service_role) is
  // created as a NOLOGIN role and inherits `authenticated`, so a request can `SET LOCAL ROLE`
  // to it (contract §13.1).
  const customRoles = [
    ...new Set(
      rules
        .map((r) => r.role)
        .filter((r) => r !== '*' && !SK_ROLES.includes(r as (typeof SK_ROLES)[number])),
    ),
  ]
  for (const role of customRoles) {
    out.push({
      text: `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}') THEN CREATE ROLE ${q(role)} NOLOGIN; END IF; END $$`,
      parameters: [],
    })
  }
  const grantRoles = ['"anon"', '"authenticated"', '"service_role"', ...customRoles.map(q)].join(
    ', ',
  )

  for (const table of rlsTables) {
    out.push({
      text: `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(table)} TO ${grantRoles}`,
      parameters: [],
    })
    out.push({ text: `ALTER TABLE ${q(table)} ENABLE ROW LEVEL SECURITY`, parameters: [] })
    out.push({ text: `ALTER TABLE ${q(table)} FORCE ROW LEVEL SECURITY`, parameters: [] })
  }

  for (const rule of rules) {
    const sqlAction = SQL_ACTION[rule.action]
    if (!sqlAction) continue
    if (!schema.tables.some((t) => t.name === rule.table)) continue
    const policyName = `sk_${rule.id}`
    out.push({
      text: `DROP POLICY IF EXISTS ${q(policyName)} ON ${q(rule.table)}`,
      parameters: [],
    })
    const to = rule.role === '*' ? 'PUBLIC' : q(rule.role)
    const mode = rule.mode === 'restrictive' ? 'RESTRICTIVE' : 'PERMISSIVE'
    const parts = [
      `CREATE POLICY ${q(policyName)} ON ${q(rule.table)} AS ${mode} FOR ${sqlAction} TO ${to}`,
    ]
    const usingExpr = usingFor(rule, sqlAction)
    const checkExpr = checkFor(rule, sqlAction)
    if (usingExpr !== null) parts.push(`USING (${exprToPgPolicy(usingExpr, rule.table)})`)
    if (checkExpr !== null) parts.push(`WITH CHECK (${exprToPgPolicy(checkExpr, rule.table)})`)
    out.push({ text: parts.join(' '), parameters: [] })
  }
  return out
}

function usingFor(rule: PolicyRule, action: string): Expr | null {
  if (action === 'INSERT') return null
  return rule.using
}

function checkFor(rule: PolicyRule, action: string): Expr | null {
  if (action === 'SELECT' || action === 'DELETE') return null
  return rule.check
}

/**
 * Compile an `Expr` to a PostgreSQL policy predicate. Unlike the schema dialect's `exprToPg`
 * (CHECK constraints only), this resolves `claim` and `context` nodes to the `sk.*` helper
 * functions, which read the per-request GUCs. When a claim / context value (always `text`) is
 * compared against a column, the column is cast to `text` so ownership checks type-check
 * regardless of the column's declared type.
 */
export function exprToPgPolicy(expr: Expr, table: string): string {
  switch (expr.kind) {
    case 'literal':
      return literal(expr.value)
    case 'column':
      return q(expr.name)
    case 'claim':
      return `sk.claim(${expr.path.map((p) => literal(p)).join(', ')})`
    case 'context':
      if (expr.name === 'subjectId') return 'sk.subject_id()'
      if (expr.name === 'tenantId') return 'sk.tenant_id()'
      if (expr.name === 'role') return 'sk.jwt_role()'
      return 'now()'
    case 'not':
      return `(NOT ${exprToPgPolicy(expr.term, table)})`
    case 'logic':
      return `(${expr.terms
        .map((t) => exprToPgPolicy(t, table))
        .join(expr.op === 'and' ? ' AND ' : ' OR ')})`
    case 'compare':
      return compare(expr, table)
    default:
      return assertNever(expr)
  }
}

function compare(expr: Expr & { kind: 'compare' }, table: string): string {
  const textCoerce = isPrincipalDerived(expr.left) || isPrincipalDerived(expr.right)
  const side = (e: Expr): string => {
    const s = exprToPgPolicy(e, table)
    return textCoerce && e.kind === 'column' ? `${s}::text` : s
  }
  const l = side(expr.left)
  if (expr.op === 'is') {
    if (expr.right.kind === 'literal' && expr.right.value === null) return `(${l} IS NULL)`
    return `(${l} IS ${exprToPgPolicy(expr.right, table)})`
  }
  if (expr.op === 'in') {
    if (expr.right.kind !== 'literal' || !Array.isArray(expr.right.value)) {
      throw new Error('IN needs a literal array')
    }
    return `(${l} IN (${expr.right.value.map((v) => literal(v)).join(', ')}))`
  }
  const r = side(expr.right)
  switch (expr.op) {
    case 'eq':
      return `(${l} = ${r})`
    case 'neq':
      return `(${l} <> ${r})`
    case 'gt':
      return `(${l} > ${r})`
    case 'gte':
      return `(${l} >= ${r})`
    case 'lt':
      return `(${l} < ${r})`
    case 'lte':
      return `(${l} <= ${r})`
    case 'like':
      return `(${l} LIKE ${r})`
    case 'ilike':
      return `(${l} ILIKE ${r})`
    default:
      return assertNever(expr.op)
  }
}

function isPrincipalDerived(e: Expr): boolean {
  return e.kind === 'claim' || (e.kind === 'context' && e.name !== 'now')
}

function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}
