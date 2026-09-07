// Bundle-audit entry for the Node profile (contract §30 L10). Pulls the full reachable graph:
// kernel + gateway composition, the Postgres/SQLite/PGlite adapters, FS + S3 blob stores, the
// node:http⇄fetch bridge and the ws realtime upgrade.
export { openFsBlob } from '@supakernel/blob-fs'
export { openS3Blob } from '@supakernel/blob-s3'
export { openPglite } from '@supakernel/db-pglite'
export { openPostgres } from '@supakernel/db-postgres'
export { openNodeSqlite } from '@supakernel/db-sqlite/node'
export { decodeFrame, encodeFrame } from '@supakernel/realtime'
export {
  attachNodeRealtime,
  NODE_LIMITS,
  readRuntimeEnv,
  serveNode,
} from '@supakernel/runtime-node'
export { composeKernel } from '../src/compose.js'
