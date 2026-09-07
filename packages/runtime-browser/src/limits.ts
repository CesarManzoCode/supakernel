import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '@supakernel/contracts'

/**
 * Browser WebWorker profile limits (contract §10). Everything is in one isolate with no
 * durable spill, so request bodies and object uploads are capped hard below the normative
 * defaults. The profile also has no public HTTP listener, no Realtime socket and no
 * Management SQL — those are exclusions, enforced at composition.
 */
export const BROWSER_LIMITS: RuntimeLimits = {
  ...DEFAULT_RUNTIME_LIMITS,
  maxRequestBodyBytes: 4 * 1024 * 1024,
  maxObjectUploadBytes: 8 * 1024 * 1024,
  socketQueueBytes: 0,
  socketQueueEvents: 0,
}
