import type { Column, ProjectSchema, Table } from '@supakernel/contracts'
import { normalizeSchema } from './normalize.js'
import { stableKey } from './stable-key.js'

/**
 * A single structural change between two `SchemaIR`s (contract §17.1). Renames are never
 * inferred: a dropped + added column is exactly that until an explicit mapping says otherwise.
 */
export type SchemaChange =
  | { kind: 'create-sequence'; sequence: string }
  | { kind: 'drop-sequence'; sequence: string; destructive: true }
  | { kind: 'alter-sequence-owner'; sequence: string }
  | { kind: 'create-table'; table: string }
  | { kind: 'drop-table'; table: string; destructive: true }
  | { kind: 'add-column'; table: string; column: string; notNullNoDefault: boolean }
  | { kind: 'drop-column'; table: string; column: string; destructive: true }
  | { kind: 'alter-column'; table: string; column: string; changed: readonly string[] }
  | { kind: 'set-primary-key'; table: string }
  | { kind: 'add-unique'; table: string; constraint: string }
  | { kind: 'drop-unique'; table: string; constraint: string; destructive: true }
  | { kind: 'add-foreign-key'; table: string; constraint: string }
  | { kind: 'drop-foreign-key'; table: string; constraint: string }
  | { kind: 'add-check'; table: string; constraint: string }
  | { kind: 'drop-check'; table: string; constraint: string; destructive: true }
  | { kind: 'add-index'; table: string; index: string }
  | { kind: 'drop-index'; table: string; index: string; destructive: true }
  | { kind: 'rebuild-table'; table: string; destructive: true }

export interface SchemaDiff {
  readonly fromHash: string
  readonly toHash: string
  readonly changes: readonly SchemaChange[]
  readonly destructive: readonly SchemaChange[]
}

/**
 * `diff(observed, desired)` — what has to happen to turn `from` into `to`. Deterministic:
 * both inputs are normalized and the change list is emitted in phase order.
 */
export function diffSchemas(
  from: ProjectSchema,
  to: ProjectSchema,
  fromHash: string,
  toHash: string,
): SchemaDiff {
  const a = normalizeSchema(from)
  const b = normalizeSchema(to)
  const changes: SchemaChange[] = []

  const aSeq = index(a.sequences, (s) => s.name)
  const bSeq = index(b.sequences, (s) => s.name)
  for (const name of sortedUnion(aSeq, bSeq)) {
    const before = aSeq.get(name)
    const after = bSeq.get(name)
    if (!before && after) changes.push({ kind: 'create-sequence', sequence: name })
    else if (before && !after)
      changes.push({ kind: 'drop-sequence', sequence: name, destructive: true })
    else if (before && after && before.ownedBy !== after.ownedBy) {
      changes.push({ kind: 'alter-sequence-owner', sequence: name })
    }
  }

  const aTab = index(a.tables, (t) => t.name)
  const bTab = index(b.tables, (t) => t.name)
  for (const name of sortedUnion(aTab, bTab)) {
    const before = aTab.get(name)
    const after = bTab.get(name)
    if (!before && after) {
      changes.push({ kind: 'create-table', table: name })
      continue
    }
    if (before && !after) {
      changes.push({ kind: 'drop-table', table: name, destructive: true })
      continue
    }
    if (before && after) diffTable(before, after, changes)
  }

  changes.sort((x, y) => PHASE[x.kind] - PHASE[y.kind])
  return {
    fromHash,
    toHash,
    changes,
    destructive: changes.filter((c) => 'destructive' in c && c.destructive),
  }
}

function diffTable(before: Table, after: Table, changes: SchemaChange[]): void {
  const aCol = index(before.columns, (c) => c.name)
  const bCol = index(after.columns, (c) => c.name)
  for (const name of sortedUnion(aCol, bCol)) {
    const x = aCol.get(name)
    const y = bCol.get(name)
    if (!x && y) {
      changes.push({
        kind: 'add-column',
        table: after.name,
        column: name,
        notNullNoDefault: !y.nullable && y.default === null && !y.generated,
      })
    } else if (x && !y) {
      changes.push({ kind: 'drop-column', table: after.name, column: name, destructive: true })
    } else if (x && y) {
      const changed = columnChanges(x, y)
      if (changed.length > 0) {
        changes.push({ kind: 'alter-column', table: after.name, column: name, changed })
      }
    }
  }

  if (stableKey([...before.primaryKey]) !== stableKey([...after.primaryKey])) {
    changes.push({ kind: 'set-primary-key', table: after.name })
  }

  diffNamed(before.uniques, after.uniques, (u) => stableKey([...u.columns]), {
    add: (u) => changes.push({ kind: 'add-unique', table: after.name, constraint: u.name }),
    drop: (u) =>
      changes.push({
        kind: 'drop-unique',
        table: after.name,
        constraint: u.name,
        destructive: true,
      }),
  })
  diffNamed(before.foreignKeys, after.foreignKeys, (fk) => stableKey(fk), {
    add: (fk) => changes.push({ kind: 'add-foreign-key', table: after.name, constraint: fk.name }),
    drop: (fk) =>
      changes.push({ kind: 'drop-foreign-key', table: after.name, constraint: fk.name }),
  })
  diffNamed(before.checks, after.checks, (c) => stableKey(c.expr), {
    add: (c) => changes.push({ kind: 'add-check', table: after.name, constraint: c.name }),
    drop: (c) =>
      changes.push({
        kind: 'drop-check',
        table: after.name,
        constraint: c.name,
        destructive: true,
      }),
  })
  diffNamed(
    before.indexes,
    after.indexes,
    (i) => `${i.unique}:${stableKey([...i.columns])}:${i.where ? stableKey(i.where) : ''}`,
    {
      add: (i) => changes.push({ kind: 'add-index', table: after.name, index: i.name }),
      drop: (i) =>
        changes.push({ kind: 'drop-index', table: after.name, index: i.name, destructive: true }),
    },
  )
}

function columnChanges(x: Column, y: Column): string[] {
  const changed: string[] = []
  if (x.type !== y.type || stableKey(x.enumLabels ?? null) !== stableKey(y.enumLabels ?? null)) {
    changed.push('type')
  }
  if (x.nullable !== y.nullable) changed.push('nullable')
  if (stableKey(x.default) !== stableKey(y.default)) changed.push('default')
  if (x.generated !== y.generated) changed.push('generated')
  return changed
}

function diffNamed<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  handlers: { add: (item: T) => void; drop: (item: T) => void },
): void {
  const b = new Map(before.map((i) => [key(i), i]))
  const a = new Map(after.map((i) => [key(i), i]))
  for (const [k, item] of a) if (!b.has(k)) handlers.add(item)
  for (const [k, item] of b) if (!a.has(k)) handlers.drop(item)
}

function index<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((i) => [key(i), i]))
}

function sortedUnion(a: Map<string, unknown>, b: Map<string, unknown>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort()
}

/** Migration phase order (contract §17.1). */
const PHASE: Record<SchemaChange['kind'], number> = {
  'create-sequence': 0,
  'drop-sequence': 90,
  'alter-sequence-owner': 5,
  'create-table': 10,
  'drop-table': 91,
  'add-column': 20,
  'drop-column': 92,
  'alter-column': 21,
  'set-primary-key': 30,
  'add-unique': 31,
  'drop-unique': 93,
  'add-foreign-key': 32,
  'drop-foreign-key': 33,
  'add-check': 34,
  'drop-check': 94,
  'add-index': 40,
  'drop-index': 95,
  'rebuild-table': 22,
}
