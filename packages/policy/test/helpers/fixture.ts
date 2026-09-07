import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Expr, PolicyRule, SchemaIR } from '@supakernel/contracts'

/**
 * The `notes` fixture (contract §30 L4). Ownership by (tenant_id, owner_id); `secret_flag` is
 * never readable; ownership columns are immutable after insert. `anon` has no rule → default
 * deny. `table` is parameterizable so parallel test files get isolated PostgreSQL tables.
 */
export interface NotesFixture {
  readonly table: string
  readonly schema: SchemaIR
  readonly policies: PolicyRule[]
  readonly pgDdl: readonly string[]
  readonly sqliteDdl: readonly string[]
}

function rewriteTable(expr: Expr, table: string): Expr {
  switch (expr.kind) {
    case 'column':
      return { kind: 'column', table, name: expr.name }
    case 'not':
      return { kind: 'not', term: rewriteTable(expr.term, table) }
    case 'compare':
      return {
        kind: 'compare',
        op: expr.op,
        left: rewriteTable(expr.left, table),
        right: rewriteTable(expr.right, table),
      }
    case 'logic':
      return { kind: 'logic', op: expr.op, terms: expr.terms.map((t) => rewriteTable(t, table)) }
    default:
      return expr
  }
}

function loadRawPolicies(): PolicyRule[] {
  const path = fileURLToPath(
    new URL('../../../../fixtures/policies/notes.policies.json', import.meta.url),
  )
  return (JSON.parse(readFileSync(path, 'utf8')) as { rules: PolicyRule[] }).rules
}

export function notesFixture(table = 'notes'): NotesFixture {
  const columns = [
    {
      name: 'id',
      type: 'uuid' as const,
      nullable: false,
      default: { kind: 'uuidV4' as const },
      generated: false,
    },
    { name: 'tenant_id', type: 'text' as const, nullable: false, default: null, generated: false },
    { name: 'owner_id', type: 'text' as const, nullable: false, default: null, generated: false },
    { name: 'title', type: 'text' as const, nullable: false, default: null, generated: false },
    { name: 'body', type: 'text' as const, nullable: true, default: null, generated: false },
    {
      name: 'secret_flag',
      type: 'bool' as const,
      nullable: false,
      default: { kind: 'literal' as const, value: false },
      generated: false,
    },
    {
      name: 'created_at',
      type: 'timestamptz' as const,
      nullable: false,
      default: { kind: 'currentTimestamp' as const },
      generated: false,
    },
  ]

  const policies: PolicyRule[] = loadRawPolicies().map((r) => ({
    ...r,
    id: table === 'notes' ? r.id : `${r.id}_${table}`,
    table,
    using: r.using ? rewriteTable(r.using, table) : null,
    check: r.check ? rewriteTable(r.check, table) : null,
  }))

  const schema: SchemaIR = {
    version: 1,
    tables: [
      {
        name: table,
        columns,
        primaryKey: ['id'],
        uniques: [],
        foreignKeys: [],
        checks: [],
        indexes: [],
      },
    ],
    sequences: [],
    policies,
  }

  return {
    table,
    schema,
    policies,
    pgDdl: [
      `DROP TABLE IF EXISTS "${table}"`,
      `CREATE TABLE "${table}" (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         tenant_id text NOT NULL,
         owner_id text NOT NULL,
         title text NOT NULL,
         body text,
         secret_flag boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    ],
    sqliteDdl: [
      `DROP TABLE IF EXISTS "${table}"`,
      `CREATE TABLE "${table}" (
         id SK_TEXT_UUID PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         owner_id TEXT NOT NULL,
         title TEXT NOT NULL,
         body TEXT,
         secret_flag SK_BOOL NOT NULL DEFAULT 0,
         created_at SK_TEXT_TSTZ NOT NULL
       )`,
    ],
  }
}

export interface Seat {
  readonly label: string
  readonly subjectId: string
  readonly tenantId: string
  readonly role: string
}

export const USER_A: Seat = {
  label: 'A',
  subjectId: 'user-a',
  tenantId: 'tenant-1',
  role: 'authenticated',
}
export const USER_B: Seat = {
  label: 'B',
  subjectId: 'user-b',
  tenantId: 'tenant-1',
  role: 'authenticated',
}
export const USER_C: Seat = {
  label: 'C',
  subjectId: 'user-c',
  tenantId: 'tenant-2',
  role: 'authenticated',
}
