/**
 * The six real runtime profiles (contract §10). This is the single source the matrix runner,
 * the receipts and the bundle audit read — nothing here is inferred at runtime.
 */
import type { RuntimeId, RuntimeLimits } from '@supakernel/contracts'
import { DEFAULT_RUNTIME_LIMITS } from '@supakernel/contracts'

export type ServiceName = 'data' | 'auth' | 'storage' | 'realtime' | 'management'

export interface RuntimeProfile {
  readonly id: RuntimeId
  /** The pinned runtime version (contract §10, §33.1). */
  readonly version: string
  /** Services that must work in this profile. */
  readonly services: readonly ServiceName[]
  /** Management is present but read-only (no mutating SQL) when true. */
  readonly managementReadOnly: boolean
  /** Database engines the profile runs against. */
  readonly databases: readonly string[]
  /** Blob backends the profile runs against. */
  readonly blobs: readonly string[]
  /** Explicit exclusions published in `/.well-known/supakernel-capabilities`. */
  readonly exclusions: readonly string[]
  readonly limits: RuntimeLimits
  /** Module specifiers that must never appear in this profile's bundle. */
  readonly forbiddenBundleImports: readonly string[]
}

const NODE_BUILTINS_FORBIDDEN = [
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:tls',
  'node:child_process',
  'node:http',
  'node:https',
  'node:worker_threads',
]

export const RUNTIME_PROFILES: Readonly<Record<RuntimeId, RuntimeProfile>> = {
  node: {
    id: 'node',
    version: '24.20.0',
    services: ['data', 'auth', 'storage', 'realtime', 'management'],
    managementReadOnly: false,
    databases: ['postgres', 'node:sqlite', 'pglite'],
    blobs: ['fs', 's3'],
    exclusions: ['rpc', 'broadcast', 'presence', 'oauth', 'mfa', 'edge-functions'],
    limits: DEFAULT_RUNTIME_LIMITS,
    forbiddenBundleImports: [],
  },
  bun: {
    id: 'bun',
    version: '1.4.1',
    services: ['data', 'auth', 'storage', 'realtime', 'management'],
    managementReadOnly: false,
    databases: ['postgres', 'bun:sqlite', 'pglite'],
    blobs: ['fs', 's3'],
    exclusions: ['rpc', 'broadcast', 'presence', 'oauth', 'mfa', 'edge-functions'],
    limits: DEFAULT_RUNTIME_LIMITS,
    forbiddenBundleImports: [],
  },
  deno: {
    id: 'deno',
    version: '2.9.6',
    services: ['data', 'auth', 'storage', 'realtime', 'management'],
    managementReadOnly: true,
    databases: ['postgres', 'pglite'],
    blobs: ['fs', 's3'],
    exclusions: [
      'rpc',
      'broadcast',
      'presence',
      'oauth',
      'mfa',
      'edge-functions',
      'management-mutating-sql',
      'smtp',
    ],
    limits: DEFAULT_RUNTIME_LIMITS,
    forbiddenBundleImports: [],
  },
  workers: {
    id: 'workers',
    version: 'wrangler@4.129.0 / compat 2026-09-01',
    services: ['data', 'auth', 'storage', 'realtime'],
    managementReadOnly: true,
    databases: ['d1'],
    blobs: ['r2'],
    exclusions: [
      'rpc',
      'broadcast',
      'presence',
      'oauth',
      'mfa',
      'edge-functions',
      'management-raw-sql',
      'smtp',
      'filesystem',
    ],
    limits: { ...DEFAULT_RUNTIME_LIMITS, maxObjectUploadBytes: 25 * 1024 * 1024 },
    forbiddenBundleImports: [...NODE_BUILTINS_FORBIDDEN, 'ws', 'pg', 'node:crypto'],
  },
  browser: {
    id: 'browser',
    version: 'Chromium (Playwright 1.63.0)',
    services: ['data', 'auth', 'storage'],
    managementReadOnly: false,
    databases: ['pglite', 'sqlite-wasm'],
    blobs: ['opfs'],
    exclusions: [
      'rpc',
      'broadcast',
      'presence',
      'oauth',
      'mfa',
      'edge-functions',
      'realtime-socket',
      'management-sql',
      'public-http-listener',
      'smtp',
    ],
    limits: {
      ...DEFAULT_RUNTIME_LIMITS,
      maxRequestBodyBytes: 4 * 1024 * 1024,
      maxObjectUploadBytes: 8 * 1024 * 1024,
      socketQueueBytes: 0,
      socketQueueEvents: 0,
    },
    forbiddenBundleImports: [...NODE_BUILTINS_FORBIDDEN, 'ws', 'pg'],
  },
  lambda: {
    id: 'lambda',
    version: 'AWS Node 24 container',
    services: ['data', 'auth', 'storage'],
    managementReadOnly: true,
    databases: ['postgres'],
    blobs: ['s3'],
    exclusions: [
      'rpc',
      'broadcast',
      'presence',
      'oauth',
      'mfa',
      'edge-functions',
      'realtime-websocket',
      'local-filesystem-durability',
    ],
    limits: {
      ...DEFAULT_RUNTIME_LIMITS,
      maxRequestBodyBytes: 6 * 1024 * 1024,
      maxObjectUploadBytes: 6 * 1024 * 1024,
      requestTimeoutMs: 29_000,
      socketQueueBytes: 0,
      socketQueueEvents: 0,
    },
    forbiddenBundleImports: [],
  },
}

export const ALL_PROFILE_IDS: readonly RuntimeId[] = [
  'node',
  'bun',
  'deno',
  'workers',
  'browser',
  'lambda',
]
