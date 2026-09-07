/// <reference path="./workers.d.ts" />
/**
 * `@supakernel/runtime-workers` — Cloudflare Workers profile primitives (contract §10, §30
 * L10): the `Env` binding shape, an R2 `BlobAdapter`, a `WebSocketPair` realtime upgrade and
 * the profile limits. D1 is provided by `@supakernel/db-sqlite/d1`. No Node built-ins are
 * imported anywhere in this package.
 */
export const RUNTIME_ID = 'workers' as const

export { readWorkersConfig, type WorkersConfig, type WorkersEnv } from './env.js'
export { WORKERS_LIMITS } from './limits.js'
export { openR2Blob, R2BlobAdapter } from './r2-blob.js'
export { type RealtimeSocket, type RealtimeUpgrade, upgradeWorkersRealtime } from './websocket.js'
