import { createHash } from 'node:crypto'
import { canonicalJson, type Json, type PolicyAction, type Principal } from '@supakernel/contracts'
import type { CombinedPolicy } from './combine.js'

/**
 * A stable hash of the *effective* rule set for one (table, action, role) evaluation
 * (contract §8, §13.1). Safe to log — it carries rule identity and structure, never claim
 * values or row data. Identical inputs always produce an identical fingerprint.
 */
export function fingerprint(
  table: string,
  action: PolicyAction,
  principal: Principal,
  combined: CombinedPolicy,
): string {
  const shape: Json = {
    table,
    action,
    role: principal.role,
    credentialSource: principal.credentialSource,
    rlsEnabled: combined.rlsEnabled,
    permissive: combined.permissive.map((p) => ruleShape(p.rule)),
    restrictive: combined.restrictive.map((r) => ruleShape(r.rule)),
  }
  return `pf_${createHash('sha256').update(canonicalJson(shape)).digest('hex').slice(0, 32)}`
}

function ruleShape(rule: {
  id: string
  mode: string
  using: unknown
  check: unknown
  fields: unknown
}): Json {
  return {
    id: rule.id,
    mode: rule.mode,
    using: (rule.using ?? null) as Json,
    check: (rule.check ?? null) as Json,
    fields: rule.fields as Json,
  }
}
