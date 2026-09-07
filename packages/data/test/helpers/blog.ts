import type { Column, Expr, PolicyRule, SchemaIR } from '@supakernel/contracts'

const col = (name: string, type: Column['type'], extra: Partial<Column> = {}): Column => ({
  name,
  type,
  nullable: false,
  default: null,
  generated: false,
  ...extra,
})

const eqCol = (name: string, ctx: 'subjectId' | 'tenantId'): Expr => ({
  kind: 'compare',
  op: 'eq',
  left: { kind: 'column', table: '', name },
  right: { kind: 'context', name: ctx },
})

function rewrite(expr: Expr, table: string): Expr {
  if (expr.kind === 'column') return { kind: 'column', table, name: expr.name }
  if (expr.kind === 'not') return { kind: 'not', term: rewrite(expr.term, table) }
  if (expr.kind === 'compare')
    return {
      kind: 'compare',
      op: expr.op,
      left: rewrite(expr.left, table),
      right: rewrite(expr.right, table),
    }
  if (expr.kind === 'logic')
    return { kind: 'logic', op: expr.op, terms: expr.terms.map((t) => rewrite(t, table)) }
  return expr
}

const authorsOwn = (t: string): Expr =>
  rewrite(
    {
      kind: 'logic',
      op: 'and',
      terms: [eqCol('tenant_id', 'tenantId'), eqCol('user_id', 'subjectId')],
    },
    t,
  )

const postsOwn = (t: string): Expr =>
  rewrite(
    {
      kind: 'logic',
      op: 'and',
      terms: [eqCol('tenant_id', 'tenantId'), eqCol('owner_id', 'subjectId')],
    },
    t,
  )

const postsVisible = (t: string): Expr =>
  rewrite(
    {
      kind: 'logic',
      op: 'and',
      terms: [
        eqCol('tenant_id', 'tenantId'),
        {
          kind: 'logic',
          op: 'or',
          terms: [
            {
              kind: 'compare',
              op: 'eq',
              left: { kind: 'column', table: '', name: 'published' },
              right: { kind: 'literal', value: true },
            },
            eqCol('owner_id', 'subjectId'),
          ],
        },
      ],
    },
    t,
  )

const POST_READ = [
  'id',
  'tenant_id',
  'owner_id',
  'author_id',
  'title',
  'body',
  'published',
  'views',
  'created_at',
]

export function blogSchema(): SchemaIR {
  const tables: SchemaIR['tables'] = [
    {
      name: 'authors',
      columns: [
        col('id', 'text', { default: { kind: 'uuidV4' } }),
        col('tenant_id', 'text'),
        col('user_id', 'text'),
        col('name', 'text'),
        col('bio', 'text', { nullable: true }),
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [],
      checks: [],
      indexes: [],
    },
    {
      name: 'posts',
      columns: [
        col('id', 'text', { default: { kind: 'uuidV4' } }),
        col('tenant_id', 'text'),
        col('owner_id', 'text'),
        col('author_id', 'text'),
        col('title', 'text'),
        col('body', 'text', { nullable: true }),
        col('published', 'bool', { default: { kind: 'literal', value: false } }),
        col('views', 'int32', { default: { kind: 'literal', value: 0 } }),
        col('secret_score', 'int64', { nullable: true }),
        col('created_at', 'timestamptz', { default: { kind: 'currentTimestamp' } }),
      ],
      primaryKey: ['id'],
      uniques: [],
      foreignKeys: [
        {
          name: 'posts_author_id_fkey',
          columns: ['author_id'],
          referencesTable: 'authors',
          referencesColumns: ['id'],
          onDelete: 'cascade',
          onUpdate: 'no-action',
        },
      ],
      checks: [],
      indexes: [],
    },
  ]

  const policies: PolicyRule[] = [
    // authors
    ...(['select', 'insert', 'update', 'delete'] as const).map((action) => ({
      id: `authors_${action}_own`,
      table: 'authors',
      action,
      role: 'authenticated',
      mode: 'permissive' as const,
      using: action === 'insert' ? null : authorsOwn('authors'),
      check: action === 'select' || action === 'delete' ? null : authorsOwn('authors'),
      fields: {
        read: '*' as const,
        write: (action === 'insert'
          ? ['id', 'tenant_id', 'user_id', 'name', 'bio']
          : ['name', 'bio']) as string[],
        immutable: ['id', 'tenant_id', 'user_id'] as string[],
      },
    })),
    // posts — authenticated
    {
      id: 'posts_tenant_guard',
      table: 'posts',
      action: 'select',
      role: 'authenticated',
      mode: 'restrictive',
      using: eqCol('tenant_id', 'tenantId'),
      check: null,
      fields: { read: '*', write: '*', immutable: [] },
    },
    {
      id: 'posts_select_visible',
      table: 'posts',
      action: 'select',
      role: 'authenticated',
      mode: 'permissive',
      using: postsVisible('posts'),
      check: null,
      fields: { read: POST_READ, write: [], immutable: [] },
    },
    ...(['insert', 'update', 'delete'] as const).map((action) => ({
      id: `posts_${action}_own`,
      table: 'posts',
      action,
      role: 'authenticated',
      mode: 'permissive' as const,
      using: action === 'insert' ? null : postsOwn('posts'),
      check: action === 'delete' ? null : postsOwn('posts'),
      fields: {
        read: POST_READ,
        write: (action === 'insert'
          ? ['id', 'tenant_id', 'owner_id', 'author_id', 'title', 'body', 'published', 'views']
          : ['title', 'body', 'published', 'views']) as string[],
        immutable: ['id', 'tenant_id', 'owner_id', 'created_at'] as string[],
      },
    })),
    // posts — anon can read published only
    {
      id: 'posts_select_anon',
      table: 'posts',
      action: 'select',
      role: 'anon',
      mode: 'permissive',
      using: {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'column', table: 'posts', name: 'published' },
        right: { kind: 'literal', value: true },
      },
      check: null,
      fields: {
        read: ['id', 'tenant_id', 'author_id', 'title', 'body', 'published', 'created_at'],
        write: [],
        immutable: [],
      },
    },
  ]

  return { version: 1, tables, sequences: [], policies }
}

export const BLOG_PG_DDL: readonly string[] = [
  'DROP TABLE IF EXISTS posts',
  'DROP TABLE IF EXISTS authors',
  `CREATE TABLE authors (
     id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
     tenant_id text NOT NULL, user_id text NOT NULL, name text NOT NULL, bio text)`,
  `CREATE TABLE posts (
     id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
     tenant_id text NOT NULL, owner_id text NOT NULL,
     author_id text NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
     title text NOT NULL, body text, published boolean NOT NULL DEFAULT false,
     views integer NOT NULL DEFAULT 0, secret_score bigint,
     created_at timestamptz NOT NULL DEFAULT now())`,
]

export const BLOG_SQLITE_DDL: readonly string[] = [
  'DROP TABLE IF EXISTS posts',
  'DROP TABLE IF EXISTS authors',
  `CREATE TABLE authors (
     id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
     name TEXT NOT NULL, bio TEXT)`,
  `CREATE TABLE posts (
     id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
     author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
     title TEXT NOT NULL, body TEXT, published SK_BOOL NOT NULL DEFAULT 0,
     views INTEGER NOT NULL DEFAULT 0, secret_score SK_TEXT_I64,
     created_at SK_TEXT_TSTZ NOT NULL DEFAULT '2026-01-01T00:00:00.000Z')`,
]
