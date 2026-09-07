import type { PolicyRule, SchemaIR } from '@supakernel/contracts'

export const NOTES_COLUMNS = ['id', 'tenant_id', 'owner_id', 'title', 'secret', 'done']

export const NOTES_SCHEMA: SchemaIR = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'int32', nullable: false, default: null, generated: false },
        { name: 'tenant_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'owner_id', type: 'text', nullable: false, default: null, generated: false },
        { name: 'title', type: 'text', nullable: false, default: null, generated: false },
        { name: 'secret', type: 'text', nullable: true, default: null, generated: false },
        {
          name: 'done',
          type: 'bool',
          nullable: false,
          default: { kind: 'literal', value: false },
          generated: false,
        },
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [],
    },
  ],
  sequences: [],
  policies: [],
}

export const NOTES_POLICIES: PolicyRule[] = [
  {
    id: 'notes_select_own',
    table: 'notes',
    action: 'select',
    role: 'authenticated',
    mode: 'permissive',
    using: {
      kind: 'compare',
      op: 'eq',
      left: { kind: 'column', table: 'notes', name: 'owner_id' },
      right: { kind: 'context', name: 'subjectId' },
    },
    check: null,
    fields: { read: ['id', 'tenant_id', 'owner_id', 'title', 'done'], write: [], immutable: [] },
  },
]

export const NOTES_DDL_SQLITE: string[] = [
  'DROP TABLE IF EXISTS notes',
  `CREATE TABLE notes (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL, secret TEXT, done SK_BOOL NOT NULL DEFAULT 0)`,
]
export const NOTES_DDL_PG: string[] = [
  'DROP TABLE IF EXISTS notes',
  `CREATE TABLE notes (id integer PRIMARY KEY, tenant_id text NOT NULL, owner_id text NOT NULL, title text NOT NULL, secret text, done boolean NOT NULL DEFAULT false)`,
]
