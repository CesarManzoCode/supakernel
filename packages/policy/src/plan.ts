import {
  asFingerprint,
  type Expr,
  isPrivilegedService,
  type PolicyAction,
  type PolicyRule,
  type Principal,
  type SchemaIR,
  type SecurityPlan,
} from '@supakernel/contracts'
import { combine } from './combine.js'
import { fieldForbidden } from './errors.js'
import { PolicyValidationError, resolvePrincipalRefs } from './expr-sql.js'
import { computeFieldMask } from './field-mask.js'
import { fingerprint } from './fingerprint.js'
import { tableColumns } from './wildcard.js'

export interface PolicyContext {
  readonly schema: SchemaIR
  /** Project policy rules; normally `schema.policies`. */
  readonly rules: readonly PolicyRule[]
  readonly principal: Principal
  /** RFC3339 UTC from the Clock port; resolves `context now` in a policy expression. */
  readonly now: string
}

export interface PlanRequest {
  readonly table: string
  readonly action: PolicyAction
  /** Columns the caller wants to read back; each must be readable or the request is refused. */
  readonly requestedReadFields?: readonly string[]
  /** Columns the caller wants to write; each must be writable or the request is refused. */
  readonly requestedWriteFields?: readonly string[]
}

/**
 * Compile a `SecurityPlan` for one operation (contract §8, §13.1).
 *
 * `rowUsing` / `rowCheck` are **principal-resolved** — every `claim` / `context` node has been
 * replaced by the value from the verified `Principal`, so the SQLite family can splice them
 * straight into a `WHERE` clause (as bound parameters) or evaluate a `WITH CHECK`. Postgres
 * enforces the same policies natively via `CREATE POLICY` (see `compile/postgres-rls`), so its
 * planner uses only `readableFields` / `writableFields` from this plan.
 */
export function buildSecurityPlan(ctx: PolicyContext, req: PlanRequest): SecurityPlan {
  const { schema, rules, principal, now } = ctx
  const allColumns = tableColumns(schema, req.table)

  if (isPrivilegedService(principal)) {
    return {
      decision: 'allow',
      rowUsing: null,
      rowCheck: null,
      readableFields: new Set(allColumns),
      writableFields: new Set(allColumns),
      fingerprint: asFingerprint('pf_service_role_bypass'),
    }
  }

  const combined = combine(schema, rules, req.table, req.action, principal)
  const fp = fingerprint(req.table, req.action, principal, combined)

  if (!combined.rlsEnabled) {
    // The table is not protected by RLS: full access, no row filter (contract §13.1 — default
    // deny applies only when RLS is enabled). This is a registered design decision.
    return {
      decision: 'allow',
      rowUsing: null,
      rowCheck: null,
      readableFields: new Set(allColumns),
      writableFields: new Set(allColumns),
      fingerprint: asFingerprint(fp),
    }
  }

  const decision: 'allow' | 'deny' = combined.permissive.length > 0 ? 'allow' : 'deny'
  const { readable, writable } = computeFieldMask(
    combined.permissive,
    combined.restrictive,
    allColumns,
  )

  if (decision === 'allow') {
    for (const f of req.requestedReadFields ?? []) {
      if (!readable.has(f)) throw new PolicyValidationError(fieldForbidden(f, 'read'))
    }
    for (const f of req.requestedWriteFields ?? []) {
      if (!writable.has(f)) throw new PolicyValidationError(fieldForbidden(f, 'write'))
    }
  }

  const resolve = (e: Expr | null): Expr | null =>
    e === null ? null : resolvePrincipalRefs(e, principal, now)

  return {
    decision,
    rowUsing: decision === 'deny' ? { kind: 'literal', value: false } : resolve(combined.rowUsing),
    rowCheck: decision === 'deny' ? { kind: 'literal', value: false } : resolve(combined.rowCheck),
    readableFields: decision === 'deny' ? new Set() : readable,
    writableFields: decision === 'deny' ? new Set() : writable,
    fingerprint: asFingerprint(fp),
  }
}
