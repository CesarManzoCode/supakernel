import {
  assertNever,
  type ContextName,
  type Expr,
  exprDepth,
  type Json,
  type KernelError,
  MAX_EXPR_DEPTH,
  type Principal,
} from '@supakernel/contracts'
import { policyInvalid } from './errors.js'

export class PolicyValidationError extends Error {
  readonly kernelError: KernelError
  constructor(ke: KernelError) {
    super(`${ke.code}: ${ke.message}`)
    this.name = 'PolicyValidationError'
    this.kernelError = ke
  }
}

/**
 * Resolve `claim` and `context` nodes against a **verified** `Principal` and the request
 * timestamp (contract §13.1). The result contains only `literal` / `column` / `compare` /
 * `logic` / `not` nodes, so it can be compiled to a plain SQL predicate with bound parameters
 * or evaluated directly. A policy expression may read only the row, verified claims,
 * subject / tenant / role / now and literals — never request input; the `Expr` grammar has no
 * node that can express request input, so this resolution is total and safe.
 */
export function resolvePrincipalRefs(expr: Expr, principal: Principal, now: string): Expr {
  switch (expr.kind) {
    case 'literal':
    case 'column':
      return expr
    case 'claim':
      return { kind: 'literal', value: claimValue(principal, expr.path) }
    case 'context':
      return { kind: 'literal', value: contextValue(principal, expr.name, now) }
    case 'not':
      return { kind: 'not', term: resolvePrincipalRefs(expr.term, principal, now) }
    case 'compare':
      return {
        kind: 'compare',
        op: expr.op,
        left: resolvePrincipalRefs(expr.left, principal, now),
        right: resolvePrincipalRefs(expr.right, principal, now),
      }
    case 'logic':
      return {
        kind: 'logic',
        op: expr.op,
        terms: expr.terms.map((t) => resolvePrincipalRefs(t, principal, now)),
      }
    default:
      return assertNever(expr)
  }
}

/** A single verified claim addressed by JSON path. Missing → `null`. */
export function claimValue(principal: Principal, path: readonly string[]): Json {
  let cur: Json = principal.claims as unknown as Json
  for (const seg of path) {
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && seg in cur) {
      cur = cur[seg] as Json
    } else {
      return null
    }
  }
  return cur
}

export function contextValue(principal: Principal, name: ContextName, now: string): Json {
  switch (name) {
    case 'subjectId':
      return principal.subjectId
    case 'tenantId':
      return principal.tenantId
    case 'role':
      return principal.role
    case 'now':
      return now
    default:
      return assertNever(name)
  }
}

/** Depth / shape guard for a policy expression (contract §10, §13.1). */
export function assertExprShape(expr: Expr, where: string): void {
  if (exprDepth(expr) > MAX_EXPR_DEPTH) {
    throw new PolicyValidationError(
      policyInvalid(`${where}: expression exceeds depth ${MAX_EXPR_DEPTH}`),
    )
  }
  walk(expr, where)
}

function walk(expr: Expr, where: string): void {
  switch (expr.kind) {
    case 'literal':
    case 'column':
    case 'context':
      return
    case 'claim':
      if (expr.path.length === 0) {
        throw new PolicyValidationError(policyInvalid(`${where}: empty claim path`))
      }
      return
    case 'not':
      walk(expr.term, where)
      return
    case 'compare':
      walk(expr.left, where)
      walk(expr.right, where)
      return
    case 'logic':
      for (const t of expr.terms) walk(t, where)
      return
    default:
      assertNever(expr)
  }
}

/**
 * Evaluate a principal-resolved `Expr` against a candidate row, with SQL ternary logic
 * (contract §9.2). Only used for INSERT / UPDATE `WITH CHECK` in the SQLite family; Postgres
 * enforces natively. The SELECT / UPDATE / DELETE `USING` predicate is always pushed into SQL,
 * never applied here (contract §13.1: no fetch-all-then-filter).
 */
export function evalCheck(expr: Expr, row: Readonly<Record<string, Json>>, now: string): boolean {
  return evalNode(expr, row, now) === true
}

type Tri = Json | undefined

function evalNode(expr: Expr, row: Readonly<Record<string, Json>>, now: string): Tri {
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'column':
      return expr.name in row ? row[expr.name] : undefined
    case 'context':
      return expr.name === 'now' ? now : undefined
    case 'claim':
      return undefined
    case 'not': {
      const t = evalNode(expr.term, row, now)
      return t === undefined ? undefined : t !== true
    }
    case 'logic': {
      const vals = expr.terms.map((t) => evalNode(t, row, now))
      if (expr.op === 'and') {
        if (vals.some((v) => v === false)) return false
        if (vals.some((v) => v === undefined)) return undefined
        return vals.every((v) => v === true)
      }
      if (vals.some((v) => v === true)) return true
      if (vals.some((v) => v === undefined)) return undefined
      return false
    }
    case 'compare':
      return evalCompare(expr, row, now)
    default:
      return assertNever(expr)
  }
}

function evalCompare(
  expr: Expr & { kind: 'compare' },
  row: Readonly<Record<string, Json>>,
  now: string,
): Tri {
  const l = evalNode(expr.left, row, now)
  const r = evalNode(expr.right, row, now)
  if (expr.op === 'is') {
    return (l ?? null) === (r ?? null)
  }
  if (l === undefined || r === undefined || l === null || r === null) return undefined
  switch (expr.op) {
    case 'eq':
      return l === r
    case 'neq':
      return l !== r
    case 'gt':
      return cmp(l, r) > 0
    case 'gte':
      return cmp(l, r) >= 0
    case 'lt':
      return cmp(l, r) < 0
    case 'lte':
      return cmp(l, r) <= 0
    case 'like':
      return likeMatch(String(l), String(r), false)
    case 'ilike':
      return likeMatch(String(l), String(r), true)
    case 'in':
      return Array.isArray(r) ? r.some((v) => l === v) : false
    default:
      return assertNever(expr.op)
  }
}

function cmp(a: Json, b: Json): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

function likeMatch(value: string, pattern: string, ci: boolean): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.')}$`,
    ci ? 'i' : '',
  )
  return re.test(value)
}
