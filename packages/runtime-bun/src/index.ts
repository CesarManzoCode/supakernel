/**
 * `@supakernel/runtime-bun` — the Bun 1.4.1 runtime profile primitives (contract §10, §30 L10):
 * env parsing, normative limits and a `Bun.serve` bridge with native WebSocket realtime.
 */
export const RUNTIME_ID = 'bun' as const

export { type RuntimeEnv, readRuntimeEnv } from './env.js'
export { BUN_LIMITS } from './limits.js'
export {
  type BunHttpServer,
  type RealtimeSocket,
  type ServeOptions,
  serveBun,
  type WebHandler,
} from './serve.js'
