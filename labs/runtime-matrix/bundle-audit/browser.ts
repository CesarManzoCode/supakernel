// Bundle-audit entry for the Browser WebWorker profile (contract §30 L10). Must contain no
// reachable Node built-in, no ws, no pg.
export { openOpfsBlob } from '@supakernel/blob-opfs'
export { openPglite } from '@supakernel/db-pglite'
export { openWasmSqlite } from '@supakernel/db-sqlite/wasm'
export { BROWSER_LIMITS, createBrowserClient, serveInWorker } from '@supakernel/runtime-browser'
export { composeKernel } from '../src/compose.js'
