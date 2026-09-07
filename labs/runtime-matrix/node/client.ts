import { createClient } from '@supabase/supabase-js'
import type { FixtureClient } from '@supakernel/fixture-app'

/**
 * A real `@supabase/supabase-js@2.115.0` client, shaped as the fixture's structural
 * `FixtureClient`. The scenario only touches the common Data / Auth / Storage surface, which is
 * structurally identical across the client's typed builders.
 */
export function supabaseFixtureClient(
  baseUrl: string,
  anonKey: string,
  fetchImpl?: typeof fetch,
): FixtureClient {
  return createClient(baseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  }) as unknown as FixtureClient
}
