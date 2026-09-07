// Bundle-audit entry for the Deno profile (contract §30 L10).
export { openFsBlob } from '@supakernel/blob-fs'
export { openS3Blob } from '@supakernel/blob-s3'
export { openPglite } from '@supakernel/db-pglite'
export { openPostgres } from '@supakernel/db-postgres'
export { decodeFrame, encodeFrame } from '@supakernel/realtime'
export { DENO_LIMITS, readRuntimeEnv, serveDeno } from '@supakernel/runtime-deno'
export { composeKernel } from '../src/compose.js'
