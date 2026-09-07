import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '@supakernel/contracts'

/**
 * Deno 2.9.6 profile limits (contract §10). The Deno profile excludes Management mutating SQL
 * and SMTP but does not reduce any numeric limit.
 */
export const DENO_LIMITS: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS }
