import { createHash } from 'node:crypto'
import { canonicalJson, type ProjectSchema } from '@supakernel/contracts'
import { normalizeSchema } from './normalize.js'

/**
 * Deterministic content hash of a normalized `SchemaIR` (contract §17.1, §30 L3). `schema.lock`
 * stores the canonical IR plus this hash; `pnpm schema:lock` must be a no-op on a clean tree.
 */
export function hashSchema(schema: ProjectSchema): string {
  const canonical = canonicalJson(
    normalizeSchema(schema) as unknown as import('@supakernel/contracts').Json,
  )
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export function canonicalSchemaJson(schema: ProjectSchema): string {
  return canonicalJson(normalizeSchema(schema) as unknown as import('@supakernel/contracts').Json)
}
