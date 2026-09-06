import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  type Expr,
  exprDepth,
  jsonEquals,
  kernelError,
  type ProjectSchema,
  parse,
  projectSchemaSchema,
  type QueryOperation,
  queryOperationSchema,
  redactError,
} from '../src/index.js'

// --- canonical JSON ---

describe('canonicalJson', () => {
  it('is key-order independent and round-trips through JSON.parse', () => {
    const a = { b: 1, a: [3, { z: true, y: null }] }
    const b = { a: [3, { y: null, z: true }], b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(JSON.parse(canonicalJson(a))).toEqual(a)
    expect(jsonEquals(a, b)).toBe(true)
  })

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY as unknown as number)).toThrow(RangeError)
  })
})

// --- QueryOperation boundary parsing ---

const selectOp: QueryOperation = {
  kind: 'select',
  table: 'notes',
  fields: [{ kind: 'column', name: 'id', alias: null }],
  where: {
    kind: 'compare',
    op: 'eq',
    left: { kind: 'column', table: 'notes', name: 'owner' },
    right: { kind: 'context', name: 'subjectId' },
  },
  order: [{ column: 'id', direction: 'asc', nulls: 'last' }],
  page: { limit: 20, offset: 0 },
  cardinality: 'many',
  count: 'exact',
}

describe('queryOperationSchema', () => {
  it('round-trips a valid select operation through JSON', () => {
    const json = JSON.parse(JSON.stringify(selectOp)) as unknown
    const result = parse(queryOperationSchema, json, 'operation')
    expect(result.ok).toBe(true)
    if (result.ok) expect(jsonEquals(result.value as never, selectOp as never)).toBe(true)
  })

  it('rejects an unknown field (strict object)', () => {
    const bad = { ...selectOp, sneaky: true }
    const result = parse(queryOperationSchema, bad, 'operation')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SK_INPUT_INVALID')
  })

  it('rejects an unknown discriminant', () => {
    const bad = { ...selectOp, kind: 'truncate' }
    const result = parse(queryOperationSchema, bad, 'operation')
    expect(result.ok).toBe(false)
  })

  it('rejects an insert with zero rows', () => {
    const result = parse(
      queryOperationSchema,
      {
        kind: 'insert',
        table: 't',
        rows: [],
        onConflict: [],
        resolution: 'error',
        missing: 'null',
        returning: 'minimal',
      },
      'operation',
    )
    expect(result.ok).toBe(false)
  })
})

// --- Expr ---

describe('Expr', () => {
  it('measures nesting depth', () => {
    const e: Expr = {
      kind: 'logic',
      op: 'and',
      terms: [
        { kind: 'not', term: { kind: 'column', table: 't', name: 'a' } },
        {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'column', table: 't', name: 'n' },
          right: { kind: 'literal', value: 1 },
        },
      ],
    }
    expect(exprDepth(e)).toBe(3)
  })
})

// --- SchemaIR round-trip + unsupported type refusal ---

const schema: ProjectSchema = {
  version: 1,
  tables: [
    {
      name: 'note',
      columns: [
        {
          name: 'id',
          type: 'int64',
          nullable: false,
          default: { kind: 'identity', sequence: 'note_id_seq' },
          generated: false,
        },
        { name: 'body', type: 'text', nullable: false, default: null, generated: false },
        {
          name: 'created_at',
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
      indexes: [],
    },
  ],
  sequences: [
    {
      name: 'note_id_seq',
      ownedBy: 'note.id',
      start: '1',
      increment: '1',
      min: '1',
      max: '9223372036854775807',
      cycle: false,
    },
  ],
  policies: [],
}

describe('projectSchemaSchema', () => {
  it('round-trips a valid SchemaIR through JSON', () => {
    const json = JSON.parse(JSON.stringify(schema)) as unknown
    const result = parse(projectSchemaSchema, json, 'schema')
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (result.ok) expect(canonicalJson(result.value as never)).toBe(canonicalJson(schema as never))
  })

  it('refuses a column type outside the portable subset with SK_CAP_SCHEMA_TYPE_UNSUPPORTED', () => {
    const bad = JSON.parse(JSON.stringify(schema)) as {
      tables: { columns: { type: string }[] }[]
    }
    const column = bad.tables[0]?.columns[1]
    if (!column) throw new Error('fixture broken')
    column.type = 'money'
    const result = parse(projectSchemaSchema, bad, 'schema')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('SK_CAP_SCHEMA_TYPE_UNSUPPORTED')
      expect(result.error.category).toBe('capability')
    }
  })
})

// --- error redaction ---

describe('redactError', () => {
  it('scrubs an internal error to a generic client-safe shape', () => {
    const e = kernelError({
      category: 'internal',
      code: 'SK_INTERNAL_QUERY',
      message: 'SELECT secret FROM auth.users WHERE id = $1 failed at /home/app/db.ts:42:1',
      httpStatus: 500,
      details: { sql: 'SELECT ...' },
    })
    const r = redactError(e)
    expect(r.message).toBe('internal error')
    expect(r.details).toBeNull()
    expect(r.hint).toBeNull()
  })

  it('scrubs a leaking message on a non-internal error but keeps the category/status', () => {
    const e = kernelError({
      category: 'integrity',
      code: 'SK_INTEGRITY',
      message: 'constraint failed: INSERT INTO objects ... sb_secret_abc123',
      httpStatus: 409,
    })
    const r = redactError(e)
    expect(r.message).toBe('integrity error')
    expect(r.httpStatus).toBe(409)
    expect(r.category).toBe('integrity')
  })

  it('leaves a clean error untouched (identity)', () => {
    const e = kernelError({
      category: 'not_found',
      code: 'PGRST116',
      message: 'row not found',
      httpStatus: 406,
    })
    expect(redactError(e)).toBe(e)
  })
})
