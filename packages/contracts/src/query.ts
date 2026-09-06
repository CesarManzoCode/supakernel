import type { Expr } from './expr.ts'
import type { Json } from './json.ts'

/** A projected column, optionally aliased, or a one-hop FK embedding (contract §11.1). */
export type Selection =
  | { readonly kind: 'column'; readonly name: string; readonly alias: string | null }
  | { readonly kind: 'all' }
  | {
      readonly kind: 'embed'
      readonly relation: string
      readonly alias: string | null
      readonly cardinality: 'many' | 'one'
      readonly fields: readonly Selection[]
    }

export interface Order {
  readonly column: string
  readonly direction: 'asc' | 'desc'
  readonly nulls: 'first' | 'last'
}

export interface Page {
  readonly limit: number
  readonly offset: number
}

/**
 * The canonical, SQL-free representation of a data operation (contract §8). The protocol codec
 * produces this; the planner and dialect compile it. Client input never reaches SQL except as
 * a bound parameter or a `SchemaIR`-validated identifier.
 */
export type QueryOperation =
  | {
      readonly kind: 'select'
      readonly table: string
      readonly fields: readonly Selection[]
      readonly where: Expr | null
      readonly order: readonly Order[]
      readonly page: Page | null
      readonly cardinality: 'many' | 'one' | 'maybeOne'
      readonly count: 'none' | 'exact'
    }
  | {
      readonly kind: 'insert'
      readonly table: string
      readonly rows: readonly Readonly<Record<string, Json>>[]
      readonly onConflict: readonly string[]
      readonly resolution: 'error' | 'merge' | 'ignore'
      readonly missing: 'null' | 'default'
      readonly returning: readonly Selection[] | 'minimal'
    }
  | {
      readonly kind: 'update'
      readonly table: string
      readonly patch: Readonly<Record<string, Json>>
      readonly where: Expr | null
      readonly returning: readonly Selection[] | 'minimal'
    }
  | {
      readonly kind: 'delete'
      readonly table: string
      readonly where: Expr | null
      readonly returning: readonly Selection[] | 'minimal'
    }

export const QUERY_KINDS = ['select', 'insert', 'update', 'delete'] as const
export type QueryKind = (typeof QUERY_KINDS)[number]

export function operationTable(op: QueryOperation): string {
  return op.table
}

/** PATCH / DELETE without a filter are refused (contract §11.3, intentional security divergence). */
export function requiresFilter(op: QueryOperation): boolean {
  return op.kind === 'update' || op.kind === 'delete'
}
