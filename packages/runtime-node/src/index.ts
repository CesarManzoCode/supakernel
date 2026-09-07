/**
 * `@supakernel/runtime-node` — the Node 24.20.0 runtime profile primitives (contract §10, §30
 * L10): environment parsing, normative limits, a `node:http` ⇄ Web `fetch` bridge and a `ws`
 * realtime upgrade. It composes nothing: the kernel + gateway are wired by the host.
 */
export const RUNTIME_ID = 'node' as const

export { type RuntimeEnv, readRuntimeEnv, type S3Env } from './env.js'
export { NODE_LIMITS } from './limits.js'
export { type NodeServer, type ServeOptions, serveNode, type WebHandler } from './serve.js'
export {
  type AttachRealtimeOptions,
  attachNodeRealtime,
  type RealtimeSocket,
} from './websocket.js'
