// PostgreSQL introspection at the schema layer: runs through the DatabaseAdapter port
// (adapter.introspect()) and normalizes for drift comparison. Raw pg_catalog SQL lives in the
// adapter (contract §6.2: schema does not import a concrete adapter).
import type { ObservedSchema } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { hashSchema } from '../hash.js'
import { normalizeSchema } from '../normalize.js'

export async function observePostgres(
  adapter: DatabaseAdapter,
): Promise<{ observed: ObservedSchema; hash: string }> {
  const observed = await adapter.introspect()
  return { observed, hash: hashSchema(normalizeSchema(observed)) }
}
