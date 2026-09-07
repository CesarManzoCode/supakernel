/**
 * `@supakernel/runtime-deno` — the Deno 2.9.6 runtime profile primitives (contract §10, §30
 * L10): env parsing, normative limits and a `Deno.serve` bridge with native WebSocket realtime.
 * The profile excludes Management mutating SQL and SMTP; that is enforced at composition.
 */
export const RUNTIME_ID = 'deno' as const

export { type RuntimeEnv, readRuntimeEnv } from './env.js'
export { DENO_LIMITS } from './limits.js'
export {
  type DenoHttpServer,
  type RealtimeSocket,
  type ServeOptions,
  serveDeno,
  type WebHandler,
} from './serve.js'
