/**
 * JSON-boundary validators (contract §8, §33.1: Zod only at external boundaries). Internal
 * code passes the already-typed discriminated unions from the other modules — it does not
 * re-validate. These schemas exist to turn untrusted JSON into a typed value or a
 * `KernelError`, with:
 *
 *  - strict unknown-field rejection (`z.strictObject`)
 *  - strict discriminant rejection (`z.discriminatedUnion`)
 *  - unsupported schema-type refusal (`SK_CAP_SCHEMA_TYPE_UNSUPPORTED`)
 *  - redacted errors (never echo the offending value verbatim for internal failures)
 */
import { z } from 'zod'
import { type KernelError, kernelError } from './error.js'
import type { Expr } from './expr.js'
import { COMPARE_OPS, CONTEXT_NAMES, EXPR_KINDS } from './expr.js'
import type { Json } from './json.js'
import { POLICY_ACTIONS } from './policy.js'
import type { QueryOperation } from './query.js'
import type { ProjectSchema } from './schema.js'
import { PORTABLE_TYPES } from './schema.js'

// --- Json ---

export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
)

// --- Expr ---

const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('literal'), value: jsonSchema }),
    z.strictObject({
      kind: z.literal('column'),
      table: z.string().min(1),
      name: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('claim'), path: z.array(z.string().min(1)).min(1) }),
    z.strictObject({ kind: z.literal('context'), name: z.enum(CONTEXT_NAMES) }),
    z.strictObject({
      kind: z.literal('compare'),
      op: z.enum(COMPARE_OPS),
      left: exprSchema,
      right: exprSchema,
    }),
    z.strictObject({
      kind: z.literal('logic'),
      op: z.enum(['and', 'or']),
      terms: z.array(exprSchema).min(1),
    }),
    z.strictObject({ kind: z.literal('not'), term: exprSchema }),
  ]),
)

export const EXPR_KIND_SET: ReadonlySet<string> = new Set(EXPR_KINDS)

// --- QueryOperation ---

const selectionSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({
      kind: z.literal('column'),
      name: z.string().min(1),
      alias: z.string().min(1).nullable(),
    }),
    z.strictObject({
      kind: z.literal('embed'),
      relation: z.string().min(1),
      alias: z.string().min(1).nullable(),
      cardinality: z.enum(['many', 'one']),
      fields: z.array(selectionSchema),
    }),
  ]),
)

const orderSchema = z.strictObject({
  column: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
  nulls: z.enum(['first', 'last']),
})

const pageSchema = z.strictObject({
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
})

const returningSchema = z.union([z.array(selectionSchema), z.literal('minimal')])

export const queryOperationSchema: z.ZodType<QueryOperation> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('select'),
    table: z.string().min(1),
    fields: z.array(selectionSchema),
    where: exprSchema.nullable(),
    order: z.array(orderSchema),
    page: pageSchema.nullable(),
    cardinality: z.enum(['many', 'one', 'maybeOne']),
    count: z.enum(['none', 'exact']),
  }),
  z.strictObject({
    kind: z.literal('insert'),
    table: z.string().min(1),
    rows: z.array(z.record(z.string(), jsonSchema)).min(1),
    onConflict: z.array(z.string().min(1)),
    resolution: z.enum(['error', 'merge', 'ignore']),
    missing: z.enum(['null', 'default']),
    returning: returningSchema,
  }),
  z.strictObject({
    kind: z.literal('update'),
    table: z.string().min(1),
    patch: z.record(z.string(), jsonSchema),
    where: exprSchema.nullable(),
    returning: returningSchema,
  }),
  z.strictObject({
    kind: z.literal('delete'),
    table: z.string().min(1),
    where: exprSchema.nullable(),
    returning: returningSchema,
  }),
]) as z.ZodType<QueryOperation>

// --- ProjectSchema (SchemaIR) ---

const portableTypeSchema = z.enum(PORTABLE_TYPES)

const columnDefaultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: jsonSchema }),
  z.strictObject({ kind: z.literal('currentTimestamp') }),
  z.strictObject({ kind: z.literal('uuidV4') }),
  z.strictObject({ kind: z.literal('identity'), sequence: z.string().min(1) }),
])

const columnSchema = z.strictObject({
  name: z.string().min(1),
  type: portableTypeSchema,
  enumLabels: z.array(z.string()).optional(),
  nullable: z.boolean(),
  default: columnDefaultSchema.nullable(),
  generated: z.boolean(),
})

const fkActionSchema = z.enum(['no-action', 'restrict', 'cascade', 'set-null'])

const tableSchema = z.strictObject({
  name: z.string().min(1),
  columns: z.array(columnSchema).min(1),
  primaryKey: z.array(z.string().min(1)),
  uniques: z.array(z.strictObject({ name: z.string(), columns: z.array(z.string().min(1)) })),
  foreignKeys: z.array(
    z.strictObject({
      name: z.string(),
      columns: z.array(z.string().min(1)),
      referencesTable: z.string().min(1),
      referencesColumns: z.array(z.string().min(1)),
      onDelete: fkActionSchema,
      onUpdate: fkActionSchema,
    }),
  ),
  checks: z.array(z.strictObject({ name: z.string(), expr: exprSchema })),
  indexes: z.array(
    z.strictObject({
      name: z.string(),
      columns: z.array(z.string().min(1)),
      unique: z.boolean(),
      where: exprSchema.nullable(),
    }),
  ),
})

const sequenceSchema = z.strictObject({
  name: z.string().min(1),
  ownedBy: z.string().nullable(),
  start: z.string(),
  increment: z.string(),
  min: z.string(),
  max: z.string(),
  cycle: z.boolean(),
})

const policyRuleSchema = z.strictObject({
  id: z.string().min(1),
  table: z.string().min(1),
  action: z.enum(POLICY_ACTIONS),
  role: z.string().min(1),
  mode: z.enum(['permissive', 'restrictive']),
  using: exprSchema.nullable(),
  check: exprSchema.nullable(),
  fields: z.strictObject({
    read: z.union([z.array(z.string()), z.literal('*')]),
    write: z.union([z.array(z.string()), z.literal('*')]),
    immutable: z.array(z.string()),
  }),
})

export const projectSchemaSchema: z.ZodType<ProjectSchema> = z.strictObject({
  version: z.literal(1),
  tables: z.array(tableSchema),
  sequences: z.array(sequenceSchema),
  policies: z.array(policyRuleSchema),
}) as z.ZodType<ProjectSchema>

// --- boundary helper ---

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KernelError }

function firstUnsupportedType(issues: readonly z.core.$ZodIssue[]): string | null {
  for (const issue of issues) {
    if (
      issue.code === 'invalid_value' &&
      issue.path.length >= 2 &&
      issue.path[issue.path.length - 1] === 'type'
    ) {
      const received = 'input' in issue ? String((issue as { input?: unknown }).input) : 'unknown'
      return received
    }
  }
  return null
}

export function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): ParseResult<T> {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }

  const unsupported = firstUnsupportedType(result.error.issues)
  if (unsupported !== null) {
    return {
      ok: false,
      error: kernelError({
        category: 'capability',
        code: 'SK_CAP_SCHEMA_TYPE_UNSUPPORTED',
        message: `schema type "${unsupported}" is outside the portable subset`,
        httpStatus: 422,
        hint: `portable types: ${PORTABLE_TYPES.join(', ')}`,
      }),
    }
  }

  const issue = result.error.issues[0]
  const path = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
  return {
    ok: false,
    error: kernelError({
      category: 'input',
      code: 'SK_INPUT_INVALID',
      message: `invalid ${what}${path}: ${issue?.message ?? 'validation failed'}`,
      httpStatus: 400,
    }),
  }
}
