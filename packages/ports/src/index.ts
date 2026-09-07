// SupaKernel ports. Implemented by adapters; wired by composition. Imports only @supakernel/contracts.
// See docs/SupaKernel-Contract.md §6.2, §8.

export type {
  BlobAdapter,
  BlobExpectation,
  BlobRead,
  BlobStat,
  ByteRange,
  StagedBlob,
} from './blob.js'
export type { ChangefeedPort, OutboxEvent } from './changefeed.js'
export type { ClockPort } from './clock.js'
export type { CryptoPort, JwtVerifyOptions, JwtVerifyResult } from './crypto.js'
export type { DatabaseAdapter, DatabaseAdapterFactory } from './database.js'
export type { FaultName, FaultPort } from './fault.js'
export { NULL_FAULT_PORT } from './fault.js'
export type { MailMessage, MailPort, MemoryMailSink } from './mail.js'
export { createMemoryMailSink } from './mail.js'
export type { RandomPort } from './random.js'
export type {
  RealtimeSession,
  RuntimeAdapter,
  ServeOptions,
  ServerHandle,
} from './runtime.js'
