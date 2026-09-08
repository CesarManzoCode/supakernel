// The mandatory upgrade release fixture (contract §17.2). A small but complete SupaKernel
// project: an identity sequence at 91 (so the target's next id must be 92), two auth users
// with password hashes, an RLS-governed `notes` table, and one private storage object.

import type { Json, PolicyRule, SchemaIR } from '@supakernel/contracts'

export const UPGRADE_FIXTURE_SCHEMA: SchemaIR = {
  version: 1,
  tables: [
    {
      name: 'events',
      columns: [
        {
          name: 'id',
          type: 'int64',
          nullable: false,
          default: { kind: 'identity', sequence: 'events_id_seq' },
          generated: false,
        },
        { name: 'kind', type: 'text', nullable: false, default: null, generated: false },
        {
          name: 'at',
          type: 'timestamptz',
          nullable: false,
          default: { kind: 'currentTimestamp' },
          generated: false,
        },
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [{ name: 'events_kind_idx', columns: ['kind'], unique: false, where: null }],
    },
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'owner', type: 'text', nullable: false, default: null, generated: false },
        { name: 'body', type: 'text', nullable: false, default: null, generated: false },
        {
          name: 'pinned',
          type: 'bool',
          nullable: false,
          default: { kind: 'literal', value: false },
          generated: false,
        },
      ],
      primaryKey: ['id'],
      uniques: [{ name: 'notes_owner_body_key', columns: ['owner', 'body'] }],
      foreignKeys: [],
      checks: [],
      indexes: [],
    },
  ],
  sequences: [
    {
      name: 'events_id_seq',
      ownedBy: 'events.id',
      start: '1',
      increment: '1',
      min: '1',
      max: '9223372036854775807',
      cycle: false,
    },
  ],
  policies: [],
}

const ownerEqSubject = {
  kind: 'compare' as const,
  op: 'eq' as const,
  left: { kind: 'column' as const, table: 'notes', name: 'owner' },
  right: { kind: 'context' as const, name: 'subjectId' as const },
}
const fields = { read: '*' as const, write: '*' as const, immutable: ['id'] }

export const UPGRADE_FIXTURE_POLICIES: readonly PolicyRule[] = [
  {
    id: 'notes_sel',
    table: 'notes',
    action: 'select',
    role: 'authenticated',
    mode: 'permissive',
    using: ownerEqSubject,
    check: null,
    fields,
  },
  {
    id: 'notes_ins',
    table: 'notes',
    action: 'insert',
    role: 'authenticated',
    mode: 'permissive',
    using: null,
    check: ownerEqSubject,
    fields,
  },
  {
    id: 'notes_upd',
    table: 'notes',
    action: 'update',
    role: 'authenticated',
    mode: 'permissive',
    using: ownerEqSubject,
    check: ownerEqSubject,
    fields,
  },
  {
    id: 'notes_del',
    table: 'notes',
    action: 'delete',
    role: 'authenticated',
    mode: 'permissive',
    using: ownerEqSubject,
    check: null,
    fields,
  },
]

export const UPGRADE_FIXTURE_EVENTS: readonly { id: number; kind: string }[] = Array.from(
  { length: 91 },
  (_, i) => ({ id: i + 1, kind: i % 2 === 0 ? 'login' : 'logout' }),
)

// GoTrue's `auth.users.id` is a real uuid — the fixture uses stable v4 uuids.
export const USER_A_ID = '11111111-1111-4111-8111-111111111111'
export const USER_B_ID = '22222222-2222-4222-8222-222222222222'

export const UPGRADE_FIXTURE_NOTES: readonly {
  id: string
  owner: string
  body: string
  pinned: boolean
}[] = [
  { id: 'n1', owner: USER_A_ID, body: 'first note', pinned: true },
  { id: 'n2', owner: USER_A_ID, body: 'second note', pinned: false },
  { id: 'n3', owner: USER_B_ID, body: 'b note', pinned: false },
]

export const UPGRADE_FIXTURE_USERS: readonly { email: string; password: string; sub: string }[] = [
  { email: 'user-a@upgrade.test', password: 'correct-horse-a', sub: USER_A_ID },
  { email: 'user-b@upgrade.test', password: 'correct-horse-b', sub: USER_B_ID },
]

export const UPGRADE_FIXTURE_OBJECT = {
  bucket: 'upg-private',
  path: 'reports/q1.txt',
  content: 'upgrade fixture object bytes — verified by sha256',
  contentType: 'text/plain',
}

export function fixtureManifest(): Json {
  return {
    schema: UPGRADE_FIXTURE_SCHEMA as unknown as Json,
    events: UPGRADE_FIXTURE_EVENTS.length,
    maxEventId: 91,
    expectedNextEventId: 92,
    notes: UPGRADE_FIXTURE_NOTES.length,
    users: UPGRADE_FIXTURE_USERS.map((u) => u.email),
    object: `${UPGRADE_FIXTURE_OBJECT.bucket}/${UPGRADE_FIXTURE_OBJECT.path}`,
  }
}
