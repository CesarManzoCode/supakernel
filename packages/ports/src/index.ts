// SupaKernel ports. Implemented by adapters; wired by composition. Imports only @supakernel/contracts.
// See docs/SupaKernel-Contract.md §6.2, §8.

export type {
  BlobAdapter,
  BlobExpectation,
  BlobRead,
  BlobStat,
  ByteRange,
  StagedBlob,
} from './blob.ts'
export type { ChangefeedPort, OutboxEvent } from './changefeed.ts'
export type { ClockPort } from './clock.ts'
export type { CryptoPort, JwtVerifyOptions, JwtVerifyResult } from './crypto.ts'
export type { DatabaseAdapter, DatabaseAdapterFactory } from './database.ts'
export type { FaultName, FaultPort } from './fault.ts'
export { NULL_FAULT_PORT } from './fault.ts'
export type { MailMessage, MailPort, MemoryMailSink } from './mail.ts'
export { createMemoryMailSink } from './mail.ts'
export type { RandomPort } from './random.ts'
export type {
  RealtimeSession,
  RuntimeAdapter,
  ServeOptions,
  ServerHandle,
} from './runtime.ts'
