import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '@supakernel/contracts'

/**
 * Node 24.20.0 profile limits (contract §10). Node has no reason to reduce any normative
 * default: it is the reference profile.
 */
export const NODE_LIMITS: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS }
