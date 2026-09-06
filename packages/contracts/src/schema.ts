import type { Expr } from './expr.ts'
import type { Json } from './json.ts'
import type { PolicyRule } from './policy.ts'

/**
 * Portable column types (contract §8, §33 SchemaIR). Every type outside this list produces
 * `SK_CAP_SCHEMA_TYPE_UNSUPPORTED` before any state is mutated.
 *
 * - `int64` and `decimal` cross the wire as strings when a value exceeds the IEEE-754 safe
 *   integer range; the schema layer marshals them and they never widen to `number`.
 */
export type PortableType =
  | 'bool'
  | 'int32'
  | 'int64'
  | 'float64'
  | 'decimal'
  | 'text'
  | 'uuid'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'json'
  | 'bytes'
  | 'enum'

export const PORTABLE_TYPES: readonly PortableType[] = [
  'bool',
  'int32',
  'int64',
  'float64',
  'decimal',
  'text',
  'uuid',
  'date',
  'timestamp',
  'timestamptz',
  'json',
  'bytes',
  'enum',
]

export function isPortableType(value: string): value is PortableType {
  return (PORTABLE_TYPES as readonly string[]).includes(value)
}

export type ColumnDefault =
  | { readonly kind: 'literal'; readonly value: Json }
  | { readonly kind: 'currentTimestamp' }
  | { readonly kind: 'uuidV4' }
  | { readonly kind: 'identity'; readonly sequence: string }

export interface Column {
  readonly name: string
  readonly type: PortableType
  /** For `enum`: the allowed labels, in declared order. */
  readonly enumLabels?: readonly string[]
  readonly nullable: boolean
  readonly default: ColumnDefault | null
  readonly generated: boolean
}

export type ForeignKeyAction = 'no-action' | 'restrict' | 'cascade' | 'set-null'

export interface ForeignKey {
  readonly name: string
  readonly columns: readonly string[]
  readonly referencesTable: string
  readonly referencesColumns: readonly string[]
  readonly onDelete: ForeignKeyAction
  readonly onUpdate: ForeignKeyAction
}

export interface UniqueConstraint {
  readonly name: string
  readonly columns: readonly string[]
}

export interface CheckConstraint {
  readonly name: string
  /** Portable `Expr` only; a check outside the grammar is refused, never dropped. */
  readonly expr: Expr
}

export interface Index {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
  /** Partial-index predicate, restricted to the portable `Expr` grammar. */
  readonly where: Expr | null
}

export interface Table {
  readonly name: string
  readonly columns: readonly Column[]
  readonly primaryKey: readonly string[]
  readonly uniques: readonly UniqueConstraint[]
  readonly foreignKeys: readonly ForeignKey[]
  readonly checks: readonly CheckConstraint[]
  readonly indexes: readonly Index[]
}

export interface Sequence {
  readonly name: string
  /** `"table.column"` the sequence is owned by; preserved even when SQLite emulates it. */
  readonly ownedBy: string | null
  readonly start: string
  readonly increment: string
  readonly min: string
  readonly max: string
  readonly cycle: boolean
}

/** JSON-serializable, versioned schema intermediate representation (contract §8). */
export interface ProjectSchema {
  readonly version: 1
  readonly tables: readonly Table[]
  readonly sequences: readonly Sequence[]
  readonly policies: readonly PolicyRule[]
}

export type SchemaIR = ProjectSchema

export function findTable(schema: ProjectSchema, name: string): Table | undefined {
  return schema.tables.find((t) => t.name === name)
}

export function findColumn(table: Table, name: string): Column | undefined {
  return table.columns.find((c) => c.name === name)
}
