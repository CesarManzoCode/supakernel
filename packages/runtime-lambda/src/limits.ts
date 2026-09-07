import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '@supakernel/contracts'

/**
 * AWS Lambda profile limits (contract §10). API Gateway caps a proxied payload at 6 MiB and
 * there is no durable local disk, so bodies and uploads are reduced accordingly. Realtime is
 * excluded, so the socket-queue limits are zeroed.
 */
export const LAMBDA_LIMITS: RuntimeLimits = {
  ...DEFAULT_RUNTIME_LIMITS,
  maxRequestBodyBytes: 6 * 1024 * 1024,
  maxObjectUploadBytes: 6 * 1024 * 1024,
  requestTimeoutMs: 29_000,
  socketQueueBytes: 0,
  socketQueueEvents: 0,
}
