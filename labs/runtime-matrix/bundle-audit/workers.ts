// Bundle-audit entry for the Cloudflare Workers profile (contract §30 L10). Must contain no
// reachable Node built-in, no ws, no pg.
export { openD1 } from '@supakernel/db-sqlite/d1'
export { decodeFrame, encodeFrame } from '@supakernel/realtime'
export {
  openR2Blob,
  readWorkersConfig,
  upgradeWorkersRealtime,
  WORKERS_LIMITS,
} from '@supakernel/runtime-workers'
export { composeKernel } from '../src/compose.js'
