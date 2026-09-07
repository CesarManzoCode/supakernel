import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '@supakernel/contracts'

/** Bun 1.4.1 profile limits (contract §10). Bun runs the full service set with the reference limits. */
export const BUN_LIMITS: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS }
