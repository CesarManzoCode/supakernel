import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '@supakernel/contracts'

/**
 * Cloudflare Workers profile limits (contract §10). Object uploads are capped well below the
 * normative default because R2 `put` buffers the body in the isolate's 128 MiB memory; a
 * runtime profile may only *reduce* a limit, which this does.
 */
export const WORKERS_LIMITS: RuntimeLimits = {
  ...DEFAULT_RUNTIME_LIMITS,
  maxObjectUploadBytes: 25 * 1024 * 1024,
}
