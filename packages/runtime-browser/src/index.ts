/**
 * `@supakernel/runtime-browser` — Browser WebWorker profile primitives (contract §10, §30
 * L10): a `MessageChannel` fetch bridge (page + worker halves), the wire protocol and the
 * profile limits. The OPFS blob store is `@supakernel/blob-opfs`; the database is
 * `@supakernel/db-pglite` or `@supakernel/db-sqlite/wasm`. No Node built-ins are imported.
 */
export const RUNTIME_ID = 'browser' as const

export { type BrowserClient, createBrowserClient } from './client.js'
export { BROWSER_LIMITS } from './limits.js'
export {
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  type WireMessage,
  type WireRequest,
  type WireResponse,
} from './protocol.js'
export { serveInWorker, type WebHandler } from './worker-bridge.js'
