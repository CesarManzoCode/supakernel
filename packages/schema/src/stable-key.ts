import { canonicalJson, type Json } from '@supakernel/contracts'

/** Deterministic string key for any JSON-serializable IR fragment (Expr, ForeignKey, …). */
export function stableKey(value: unknown): string {
  return canonicalJson(value as Json)
}
