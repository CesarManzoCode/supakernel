// The conformance scenario set (contract §11, §12, §14, §15, §16). One declarative
// ScenarioSpec per behaviour; the same spec is replayed against every mandatory target.

import type { ScenarioSpec, ScenarioStep } from '@supakernel/contracts'
import { assertScenario } from './schema.js'

const SEED = '00000000000000000000000000000001'

const notesTable: ScenarioStep = {
  id: 'create-notes',
  action: 'schema.createTable',
  input: {
    name: 'notes',
    columns: [
      { name: 'id', type: 'int', nullable: false },
      { name: 'owner', type: 'text', nullable: false },
      { name: 'title', type: 'text', nullable: false },
      { name: 'done', type: 'bool', nullable: false, default: 'false' },
    ],
    primaryKey: ['id'],
    unique: [['owner', 'title']],
  },
}

const define = (spec: ScenarioSpec): ScenarioSpec => {
  assertScenario(spec)
  return spec
}

// ---------------------------------------------------------------------------- data (§11)

const dataCrudCount = define({
  schemaVersion: 1,
  id: 'data.crud-and-exact-count',
  capability: 'data',
  requires: ['data'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    notesTable,
    {
      id: 'seed',
      action: 'db.seed',
      input: {
        table: 'notes',
        rows: [
          { id: 1, owner: 'a', title: 'first', done: false },
          { id: 2, owner: 'a', title: 'second', done: true },
          { id: 3, owner: 'b', title: 'third', done: false },
        ],
      },
    },
  ],
  operations: [
    {
      id: 'select-eq',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: 'id,owner,title,done',
        filters: [['owner', 'eq', 'a']],
        order: { column: 'id' },
      },
    },
    {
      id: 'select-count',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: 'id',
        count: 'exact',
        order: { column: 'id' },
      },
    },
    {
      id: 'insert-return',
      action: 'data.insert',
      input: {
        seat: 'service',
        table: 'notes',
        values: { id: 4, owner: 'b', title: 'fourth', done: false },
        select: '*',
      },
    },
    {
      id: 'update-return',
      action: 'data.update',
      input: {
        seat: 'service',
        table: 'notes',
        values: { done: true },
        filters: [['id', 'eq', 4]],
        select: 'id,done',
      },
    },
    {
      id: 'delete-return',
      action: 'data.delete',
      input: { seat: 'service', table: 'notes', filters: [['id', 'eq', 4]], select: 'id' },
    },
  ],
  observe: [{ id: 'final-rows', of: 'db-state', selector: { table: 'notes', orderBy: 'id' } }],
  compare: { mode: 'exact' },
  normalization: ['timestamp-window', 'uuid-bijection'],
  seed: SEED,
})

const dataSingleCardinality = define({
  schemaVersion: 1,
  id: 'data.single-cardinality-error',
  capability: 'data',
  requires: ['data'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    notesTable,
    {
      id: 'seed',
      action: 'db.seed',
      input: {
        table: 'notes',
        rows: [
          { id: 1, owner: 'a', title: 'x', done: false },
          { id: 2, owner: 'a', title: 'y', done: false },
        ],
      },
    },
  ],
  operations: [
    {
      id: 'single-too-many',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: '*',
        filters: [['owner', 'eq', 'a']],
        single: true,
      },
    },
    {
      id: 'single-none',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: '*',
        filters: [['owner', 'eq', 'zzz']],
        single: true,
      },
    },
    {
      id: 'maybe-single-none',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: '*',
        filters: [['owner', 'eq', 'zzz']],
        maybeSingle: true,
      },
    },
  ],
  observe: [],
  compare: { mode: 'exact' },
  normalization: ['constraint-name'],
  seed: SEED,
})

const dataConstraintError = define({
  schemaVersion: 1,
  id: 'data.unique-violation-error',
  capability: 'data',
  requires: ['data'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    notesTable,
    {
      id: 'seed',
      action: 'db.seed',
      input: { table: 'notes', rows: [{ id: 1, owner: 'a', title: 'dup', done: false }] },
    },
  ],
  operations: [
    {
      id: 'insert-dup',
      action: 'data.insert',
      input: {
        seat: 'service',
        table: 'notes',
        values: { id: 2, owner: 'a', title: 'dup', done: false },
      },
    },
    {
      id: 'insert-missing-col',
      action: 'data.insert',
      input: { seat: 'service', table: 'notes', values: { id: 3, owner: 'a' } },
    },
  ],
  observe: [{ id: 'rows', of: 'db-state', selector: { table: 'notes', orderBy: 'id' } }],
  compare: { mode: 'exact' },
  normalization: ['constraint-name'],
  seed: SEED,
})

const dataRangePagination = define({
  schemaVersion: 1,
  id: 'data.range-pagination-window',
  capability: 'data',
  requires: ['data'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    notesTable,
    {
      id: 'seed',
      action: 'db.seed',
      input: {
        table: 'notes',
        rows: Array.from({ length: 6 }, (_, i) => ({
          id: i + 1,
          owner: 'a',
          title: `n${i + 1}`,
          done: false,
        })),
      },
    },
  ],
  operations: [
    {
      id: 'page-1',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: 'id',
        order: { column: 'id' },
        range: [0, 1],
        count: 'exact',
      },
    },
    {
      id: 'page-2',
      action: 'data.select',
      input: {
        seat: 'service',
        table: 'notes',
        columns: 'id',
        order: { column: 'id' },
        range: [2, 3],
        count: 'exact',
      },
    },
  ],
  observe: [],
  compare: { mode: 'exact' },
  normalization: [],
  seed: SEED,
})

// ---------------------------------------------------------------------------- auth (§12)

const authSignupLoginRefresh = define({
  schemaVersion: 1,
  id: 'auth.signup-login-refresh-logout',
  capability: 'auth',
  requires: ['auth'],
  setup: [{ id: 'reset', action: 'schema.reset', input: {} }],
  operations: [
    {
      id: 'signup',
      action: 'auth.signUp',
      input: { seat: 'anon', email: 'alice@conformance.test', password: 'Sup3r-secret-pw' },
    },
    {
      id: 'login',
      action: 'auth.signInWithPassword',
      input: { seat: 'anon', email: 'alice@conformance.test', password: 'Sup3r-secret-pw' },
    },
    { id: 'me', action: 'auth.getUser', input: { seat: 'anon' } },
    { id: 'refresh', action: 'auth.refreshSession', input: { seat: 'anon' } },
    { id: 'refresh-again', action: 'auth.refreshSession', input: { seat: 'anon' } },
    { id: 'logout', action: 'auth.signOut', input: { seat: 'anon' } },
  ],
  observe: [],
  compare: {
    mode: 'subset',
    extraVendorFields: [
      'confirmation_sent_at',
      'phone',
      'identities',
      'is_anonymous',
      'app_metadata',
      'user_metadata',
      'last_sign_in_at',
      'confirmed_at',
      'email_confirmed_at',
      'invited_at',
      'recovery_sent_at',
      'factors',
      'created_at',
      'updated_at',
      'aud',
      'weak_password',
      'provider_token',
      'provider_refresh_token',
      // issuer-specific session/JWT extras — supabase-js does not require them
      'sessionId',
      'session_id',
      'aal',
      'amr',
      'expires_at',
      'expires_in',
      'role',
      'is_sso_user',
    ],
  },
  normalization: ['jwt-claims', 'uuid-bijection', 'timestamp-window'],
  seed: SEED,
})

const authBadPassword = define({
  schemaVersion: 1,
  id: 'auth.wrong-password-error',
  capability: 'auth',
  requires: ['auth'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    {
      id: 'user',
      action: 'auth.adminCreateUser',
      input: { email: 'bob@conformance.test', password: 'correct-horse-battery' },
    },
  ],
  operations: [
    {
      id: 'login-bad',
      action: 'auth.signInWithPassword',
      input: { seat: 'anon', email: 'bob@conformance.test', password: 'wrong' },
    },
    {
      id: 'login-unknown',
      action: 'auth.signInWithPassword',
      input: { seat: 'anon', email: 'nobody@conformance.test', password: 'whatever' },
    },
  ],
  observe: [],
  compare: { mode: 'subset', extraVendorFields: ['error_code'] },
  normalization: ['jwt-claims'],
  seed: SEED,
})

// ---------------------------------------------------------------------------- storage (§14)

const storageRoundTrip = define({
  schemaVersion: 1,
  id: 'storage.upload-download-list-signed-remove',
  capability: 'storage',
  requires: ['storage'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    {
      id: 'bucket',
      action: 'storage.createBucket',
      input: { name: 'conf-private', public: false },
    },
  ],
  operations: [
    {
      id: 'upload',
      action: 'storage.upload',
      input: {
        seat: 'service',
        bucket: 'conf-private',
        path: 'docs/hello.txt',
        content: 'conformance-bytes',
      },
    },
    {
      id: 'download',
      action: 'storage.download',
      input: { seat: 'service', bucket: 'conf-private', path: 'docs/hello.txt' },
    },
    {
      id: 'list',
      action: 'storage.list',
      input: { seat: 'service', bucket: 'conf-private', prefix: 'docs' },
    },
    {
      id: 'sign',
      action: 'storage.createSignedUrl',
      input: { seat: 'service', bucket: 'conf-private', path: 'docs/hello.txt', expiresIn: 60 },
    },
    { id: 'sign-get', action: 'storage.signedUrlGet', input: { seat: 'service' } },
    {
      id: 'remove',
      action: 'storage.remove',
      input: { seat: 'service', bucket: 'conf-private', paths: ['docs/hello.txt'] },
    },
    {
      id: 'download-gone',
      action: 'storage.download',
      input: { seat: 'service', bucket: 'conf-private', path: 'docs/hello.txt' },
    },
  ],
  observe: [],
  compare: {
    mode: 'subset',
    extraVendorFields: [
      'id',
      'version',
      'created_at',
      'updated_at',
      'last_accessed_at',
      'metadata',
      'buckets',
      'owner',
      'owner_id',
      'bucket_id',
      'cacheControl',
      'contentLength',
      'httpStatusCode',
      'lastModified',
      'eTag',
      'mimetype',
      'size',
      'path_tokens',
      'user_metadata',
    ],
  },
  normalization: ['url-origin', 'jwt-claims', 'uuid-bijection', 'timestamp-window'],
  seed: SEED,
})

// ---------------------------------------------------------------------------- realtime (§15)

const realtimeOrderedChanges = define({
  schemaVersion: 1,
  id: 'realtime.ordered-postgres-changes',
  capability: 'realtime',
  requires: ['realtime'],
  setup: [
    { id: 'reset', action: 'schema.reset', input: {} },
    notesTable,
    { id: 'register', action: 'realtime.registerTable', input: { table: 'notes' } },
  ],
  operations: [
    { id: 'subscribe', action: 'realtime.subscribe', input: { seat: 'anon', table: 'notes' } },
    {
      id: 'mutate',
      action: 'realtime.mutate',
      input: {
        table: 'notes',
        rows: [
          { id: 1, owner: 'a', title: 'r1', done: false },
          { id: 2, owner: 'a', title: 'r2', done: false },
        ],
      },
    },
    { id: 'collect', action: 'realtime.collect', input: {} },
  ],
  observe: [],
  compare: { mode: 'ordered-sequence' },
  normalization: ['timestamp-window', 'uuid-bijection'],
  seed: SEED,
})

// ---------------------------------------------------------------------------- management (§16)

const managementSurface = define({
  schemaVersion: 1,
  id: 'management.projects-keys-capabilities',
  capability: 'management',
  requires: ['management'],
  setup: [{ id: 'reset', action: 'schema.reset', input: {} }],
  operations: [
    { id: 'projects', action: 'management.listProjects', input: {} },
    { id: 'keys', action: 'management.getApiKeys', input: { ref: 'local' } },
    { id: 'caps', action: 'management.capabilities', input: {} },
    {
      id: 'query-ok',
      action: 'management.runQuery',
      input: { ref: 'local', query: 'select 1 as one' },
    },
    {
      id: 'query-refused',
      action: 'management.runQuery',
      input: { ref: 'local', query: 'drop table notes' },
    },
  ],
  observe: [],
  compare: {
    // Management has no local vendor oracle (§16 — hosted is opt-in), so the check is
    // cross-family self-consistency between supakernel.pg and supakernel.sqlite. The database
    // *identity* fields legitimately differ and are excluded.
    mode: 'subset',
    extraVendorFields: [
      'version',
      'families',
      'family',
      'postgres_version',
      'db_host',
      'db_port',
      'db_name',
      'db_user',
      'host',
      'cpu',
      'platform',
      'release',
      'coreHash',
      'core_hash',
    ],
  },
  normalization: ['uuid-bijection', 'timestamp-window'],
  seed: SEED,
})

export const DATA_SCENARIOS: readonly ScenarioSpec[] = [
  dataCrudCount,
  dataSingleCardinality,
  dataConstraintError,
  dataRangePagination,
]
export const AUTH_SCENARIOS: readonly ScenarioSpec[] = [authSignupLoginRefresh, authBadPassword]
export const STORAGE_SCENARIOS: readonly ScenarioSpec[] = [storageRoundTrip]
export const REALTIME_SCENARIOS: readonly ScenarioSpec[] = [realtimeOrderedChanges]
export const MANAGEMENT_SCENARIOS: readonly ScenarioSpec[] = [managementSurface]

export const ALL_SCENARIOS: readonly ScenarioSpec[] = [
  ...DATA_SCENARIOS,
  ...AUTH_SCENARIOS,
  ...STORAGE_SCENARIOS,
  ...REALTIME_SCENARIOS,
  ...MANAGEMENT_SCENARIOS,
]

export function scenariosForLane(lane: 'pr' | 'nightly'): readonly ScenarioSpec[] {
  // PR: Data / Auth / Storage / Management against supabase-local + kernel.
  // Nightly: adds Realtime.
  return lane === 'nightly'
    ? ALL_SCENARIOS
    : [...DATA_SCENARIOS, ...AUTH_SCENARIOS, ...STORAGE_SCENARIOS, ...MANAGEMENT_SCENARIOS]
}

export function scenariosByCapability(capability: string): readonly ScenarioSpec[] {
  return ALL_SCENARIOS.filter((s) => s.capability === capability)
}
