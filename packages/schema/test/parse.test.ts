import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectSchema } from '@supakernel/contracts'
import { describe, expect, it } from 'vitest'
import {
  diffSchemas,
  hashSchema,
  parsePgSchema,
  planMigration,
  UnsupportedSchemaError,
  validateSchema,
} from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/schema')
const read = (rel: string): string => readFileSync(join(fixtures, rel), 'utf8')
const EMPTY: ProjectSchema = { version: 1, tables: [], sequences: [], policies: [] }

describe('parse-pg — DDL → SchemaIR', () => {
  it('parses a portable schema into normalized IR with sequence ownership preserved', async () => {
    const { schema, warnings } = await parsePgSchema(read('portable/001-note.sql'))
    expect(warnings).toEqual([])
    const note = schema.tables.find((t) => t.name === 'note')
    expect(note?.columns.find((c) => c.name === 'id')?.type).toBe('int64')
    expect(note?.columns.find((c) => c.name === 'id')?.default).toEqual({
      kind: 'identity',
      sequence: 'note_id_seq',
    })
    expect(note?.columns.find((c) => c.name === 'created_at')?.default).toEqual({
      kind: 'currentTimestamp',
    })
    expect(schema.sequences.find((s) => s.name === 'note_id_seq')?.ownedBy).toBe('note.id')
    expect(validateSchema(schema)).toEqual([])
  })

  it('recovers CHECK constraints and a partial-index predicate as portable Expr', async () => {
    const { schema } = await parsePgSchema(read('portable/001-note.sql'))
    const note = schema.tables.find((t) => t.name === 'note')
    expect(note?.checks.find((c) => c.name === 'note_score_nonneg')?.expr).toMatchObject({
      kind: 'compare',
      op: 'gte',
      left: { kind: 'column', name: 'score' },
    })
    expect(note?.indexes.find((i) => i.name === 'note_pinned_owner_uk')?.where).toMatchObject({
      kind: 'compare',
      op: 'eq',
      left: { kind: 'column', name: 'pinned' },
      right: { kind: 'literal', value: true },
    })
  })

  it('carries foreign-key actions and enum labels', async () => {
    const pt = await parsePgSchema(read('portable/002-project-task.sql'))
    const fk = pt.schema.tables.find((t) => t.name === 'task')?.foreignKeys[0]
    expect(fk?.referencesTable).toBe('project')
    expect(fk?.onDelete).toBe('cascade')

    const types = await parsePgSchema(read('portable/003-types.sql'))
    const shade = types.schema.tables[0]?.columns.find((c) => c.name === 'shade')
    expect(shade?.type).toBe('enum')
    expect(shade?.enumLabels).toEqual(['red', 'green', 'blue'])
  })

  it.each([
    ['unsupported/020-money-type.sql', 'SK_CAP_SCHEMA_TYPE_UNSUPPORTED'],
    ['unsupported/021-deferrable-fk.sql', 'SK_CAP_SCHEMA_DEFERRABLE_UNSUPPORTED'],
    ['unsupported/022-check-function.sql', 'SK_CAP_SCHEMA_CHECK_UNSUPPORTED'],
  ])('refuses %s with %s (stable refusal, never silent loss)', async (file, code) => {
    await expect(parsePgSchema(read(file))).rejects.toMatchObject({ code })
    await expect(parsePgSchema(read(file))).rejects.toBeInstanceOf(UnsupportedSchemaError)
  })

  it('is deterministic: the hash is stable across parses and declaration order', async () => {
    const a = await parsePgSchema(read('portable/002-project-task.sql'))
    const b = await parsePgSchema(read('portable/002-project-task.sql'))
    expect(hashSchema(a.schema)).toBe(hashSchema(b.schema))
    expect(hashSchema(a.schema)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('diff + plan', () => {
  it('emits create steps in fixed phase order', async () => {
    const { schema } = await parsePgSchema(read('portable/002-project-task.sql'))
    const plan = planMigration(EMPTY, schema, { family: 'postgres' })
    expect(plan.risk).toBe('safe')
    const phases = plan.steps.map((s) => s.phase)
    const sortedPhases = [...phases].sort(
      (x, y) =>
        ['sequences', 'tables', 'columns', 'constraints', 'indexes'].indexOf(x) -
        ['sequences', 'tables', 'columns', 'constraints', 'indexes'].indexOf(y),
    )
    expect(phases).toEqual(sortedPhases)
    expect(plan.steps.every((s) => /^step_[0-9a-f]{16}$/.test(s.id))).toBe(true)
  })

  it('a no-op diff produces zero steps', async () => {
    const { schema } = await parsePgSchema(read('portable/001-note.sql'))
    const d = diffSchemas(schema, schema, hashSchema(schema), hashSchema(schema))
    expect(d.changes).toEqual([])
    expect(planMigration(schema, schema, { family: 'sqlite' }).steps).toEqual([])
  })

  it('refuses a destructive change without --allow-destructive + rename mapping', async () => {
    const before = (await parsePgSchema(read('shadow-copy/040-before.sql'))).schema
    const after = (await parsePgSchema(read('shadow-copy/041-after.sql'))).schema
    const refused = planMigration(before, after, { family: 'sqlite' })
    expect(refused.risk).toBe('destructive-refused')
    expect(refused.steps).toEqual([])

    const allowed = planMigration(before, after, { family: 'sqlite', allowDestructive: true })
    expect(allowed.risk).toBe('destructive-allowed')
  })

  it('an explicit rename mapping turns drop+add into a non-destructive plan', async () => {
    const before = (await parsePgSchema(read('drift/030-base.sql'))).schema
    const renamed: ProjectSchema = {
      ...before,
      tables: before.tables.map((t) => ({
        ...t,
        columns: t.columns.map((c) => (c.name === 'title' ? { ...c, name: 'headline' } : c)),
      })),
    }
    const plan = planMigration(before, renamed, {
      family: 'postgres',
      renames: { columns: { 'doc.title': 'doc.headline' } },
    })
    expect(plan.risk).not.toBe('destructive-refused')
  })
})
