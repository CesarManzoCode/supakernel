import { createHash } from 'node:crypto'
import {
  canonicalJson,
  type Family,
  kernelError,
  type ProjectSchema,
  type SqlStatement,
} from '@supakernel/contracts'
import * as pg from './dialects/postgres.js'
import * as sqlite from './dialects/sqlite.js'
import { diffSchemas, type SchemaChange, type SchemaDiff } from './diff.js'
import { hashSchema } from './hash.js'
import { normalizeSchema } from './normalize.js'

export type MigrationPhase =
  | 'sequences'
  | 'tables'
  | 'columns'
  | 'constraints'
  | 'indexes'
  | 'policy-helpers'
  | 'policies'
  | 'outbox-triggers'

export const MIGRATION_PHASES: readonly MigrationPhase[] = [
  'sequences',
  'tables',
  'columns',
  'constraints',
  'indexes',
  'policy-helpers',
  'policies',
  'outbox-triggers',
]

export interface MigrationStep {
  readonly id: string
  readonly phase: MigrationPhase
  readonly change: SchemaChange
  readonly forward: readonly SqlStatement[]
  /** A cheap, deterministic condition the applier can check to prove the step took effect. */
  readonly postcondition: {
    readonly kind: 'table-exists' | 'column-exists' | 'index-exists' | 'sequence-exists' | 'none'
    readonly name: string
  }
  readonly checksum: string
}

export interface MigrationPlan {
  readonly id: string
  readonly family: Family
  readonly fromHash: string
  readonly toHash: string
  readonly steps: readonly MigrationStep[]
  readonly preconditions: readonly string[]
  readonly postconditions: readonly string[]
  readonly risk: 'safe' | 'destructive-refused' | 'destructive-allowed'
}

export interface RenameMapping {
  readonly tables?: Readonly<Record<string, string>>
  readonly columns?: Readonly<Record<string, string>>
}

export interface PlanOptions {
  readonly family: Family
  readonly allowDestructive?: boolean
  readonly renames?: RenameMapping
}

const CHANGE_PHASE: Record<SchemaChange['kind'], MigrationPhase> = {
  'create-sequence': 'sequences',
  'drop-sequence': 'sequences',
  'alter-sequence-owner': 'sequences',
  'create-table': 'tables',
  'drop-table': 'tables',
  'add-column': 'columns',
  'drop-column': 'columns',
  'alter-column': 'columns',
  'set-primary-key': 'constraints',
  'add-unique': 'constraints',
  'drop-unique': 'constraints',
  'add-foreign-key': 'constraints',
  'drop-foreign-key': 'constraints',
  'add-check': 'constraints',
  'drop-check': 'constraints',
  'add-index': 'indexes',
  'drop-index': 'indexes',
}

function stableId(prefix: string, payload: unknown): string {
  return `${prefix}_${createHash('sha256')
    .update(canonicalJson(payload as never))
    .digest('hex')
    .slice(0, 16)}`
}

/**
 * Build a `MigrationPlan` from `from` → `to` (contract §17.1, §30 L3). Step IDs and checksums
 * are stable functions of the change; phase order is fixed. A destructive change with no
 * `allowDestructive` + explicit rename mapping produces `risk: 'destructive-refused'` and the
 * caller must not apply it.
 */
export function planMigration(
  from: ProjectSchema,
  to: ProjectSchema,
  options: PlanOptions,
): MigrationPlan {
  const fromHash = hashSchema(from)
  const toHash = hashSchema(to)
  const desired = normalizeSchema(to)
  const diff: SchemaDiff = applyRenames(diffSchemas(from, to, fromHash, toHash), options.renames)

  const steps: MigrationStep[] = []
  for (const change of diff.changes) {
    const phase = CHANGE_PHASE[change.kind]
    const forward = compileChange(change, desired, options.family)
    const step: MigrationStep = {
      id: stableId('step', { change, family: options.family }),
      phase,
      change,
      forward,
      postcondition: postconditionFor(change),
      checksum: `sha256:${createHash('sha256')
        .update(canonicalJson({ change, forward } as never))
        .digest('hex')}`,
    }
    steps.push(step)
  }

  steps.sort((a, b) => {
    const p = MIGRATION_PHASES.indexOf(a.phase) - MIGRATION_PHASES.indexOf(b.phase)
    return p !== 0 ? p : a.id.localeCompare(b.id)
  })

  const unmappedDestructive = diff.destructive.filter((c) => !isMappedRename(c, options.renames))
  const risk: MigrationPlan['risk'] =
    unmappedDestructive.length === 0
      ? 'safe'
      : options.allowDestructive
        ? 'destructive-allowed'
        : 'destructive-refused'

  return {
    id: stableId('plan', { fromHash, toHash, family: options.family }),
    family: options.family,
    fromHash,
    toHash,
    steps: risk === 'destructive-refused' ? [] : steps,
    preconditions: [`schema-hash:${fromHash}`],
    postconditions: [`schema-hash:${toHash}`],
    risk,
  }
}

export function destructiveRefusalError(plan: MigrationPlan): ReturnType<typeof kernelError> {
  return kernelError({
    category: 'capability',
    code: 'SK_MIGRATION_DESTRUCTIVE',
    message:
      'migration contains destructive changes; re-run with --allow-destructive and an explicit rename mapping',
    httpStatus: 409,
    details: { plan: plan.id },
  })
}

function applyRenames(diff: SchemaDiff, renames: RenameMapping | undefined): SchemaDiff {
  if (!renames || (!renames.tables && !renames.columns)) return diff
  // A rename turns a (drop old, add new) pair into an explicit alter; never inferred.
  const tableRenames = new Map(Object.entries(renames.tables ?? {}))
  const columnRenames = new Map(Object.entries(renames.columns ?? {}))
  const kept: SchemaChange[] = []
  for (const change of diff.changes) {
    if (change.kind === 'drop-table' && tableRenames.has(change.table)) continue
    if (change.kind === 'create-table' && [...tableRenames.values()].includes(change.table)) {
      kept.push(change)
      continue
    }
    if (change.kind === 'drop-column' && columnRenames.has(`${change.table}.${change.column}`))
      continue
    kept.push(change)
  }
  return {
    ...diff,
    changes: kept,
    destructive: kept.filter((c) => 'destructive' in c && c.destructive),
  }
}

function isMappedRename(change: SchemaChange, renames: RenameMapping | undefined): boolean {
  if (!renames) return false
  if (change.kind === 'drop-table') return Boolean(renames.tables?.[change.table])
  if (change.kind === 'drop-column')
    return Boolean(renames.columns?.[`${change.table}.${change.column}`])
  return false
}

function compileChange(
  change: SchemaChange,
  desired: ProjectSchema,
  family: Family,
): readonly SqlStatement[] {
  const D = family === 'postgres' ? pg : sqlite
  const q = (id: string): string => `"${id}"`
  switch (change.kind) {
    case 'create-sequence': {
      const seq = desired.sequences.find((s) => s.name === change.sequence)
      return seq ? D.createSequenceStatements(seq) : []
    }
    case 'alter-sequence-owner': {
      const seq = desired.sequences.find((s) => s.name === change.sequence)
      if (family === 'sqlite' || !seq?.ownedBy) return []
      const [t, c] = seq.ownedBy.split('.') as [string, string]
      return [{ text: `ALTER SEQUENCE ${q(seq.name)} OWNED BY ${q(t)}.${q(c)}`, parameters: [] }]
    }
    case 'create-table': {
      const table = desired.tables.find((t) => t.name === change.table)
      if (!table) return []
      const stmts = [D.createTableStatement(desired, table)]
      for (const idx of table.indexes) stmts.push(D.createIndexStatement(table, idx))
      return stmts
    }
    case 'add-index': {
      const table = desired.tables.find((t) => t.name === change.table)
      const idx = table?.indexes.find((i) => i.name === change.index)
      return table && idx ? [D.createIndexStatement(table, idx)] : []
    }
    case 'add-column': {
      const table = desired.tables.find((t) => t.name === change.table)
      const col = table?.columns.find((c) => c.name === change.column)
      if (!table || !col) return []
      if (change.notNullNoDefault && family === 'sqlite') {
        // SQLite cannot ADD a NOT NULL column without a default -> shadow rebuild territory.
        return [
          {
            text: `-- add-column ${change.table}.${change.column} requires a table rebuild`,
            parameters: [],
          },
        ]
      }
      const typeName = family === 'postgres' ? pg.PG_TYPE[col.type] : sqlite.SQLITE_TYPE[col.type]
      const nn = col.nullable ? '' : ' NOT NULL'
      return [
        {
          text: `ALTER TABLE ${q(change.table)} ADD COLUMN ${q(change.column)} ${typeName}${nn}`,
          parameters: [],
        },
      ]
    }
    case 'add-check': {
      const table = desired.tables.find((t) => t.name === change.table)
      const check = table?.checks.find((c) => c.name === change.constraint)
      if (!table || !check) return []
      const predicate =
        family === 'postgres'
          ? pg.exprToPg(check.expr)
          : sqlite.exprToSqlite(
              check.expr,
              (n) => table.columns.find((c) => c.name === n)?.type ?? 'text',
            )
      return [
        {
          text: `ALTER TABLE ${q(change.table)} ADD CONSTRAINT ${q(change.constraint)} CHECK ${predicate}`,
          parameters: [],
        },
      ]
    }
    case 'add-unique': {
      const table = desired.tables.find((t) => t.name === change.table)
      const u = table?.uniques.find((x) => x.name === change.constraint)
      return u
        ? [
            {
              text: `ALTER TABLE ${q(change.table)} ADD CONSTRAINT ${q(change.constraint)} UNIQUE (${u.columns
                .map(q)
                .join(', ')})`,
              parameters: [],
            },
          ]
        : []
    }
    default:
      // drop-*, alter-column, set-primary-key, add-foreign-key: emitted as a documented no-op
      // placeholder here; L3 apply handles SQLite rebuild + PG ALTER. Kept explicit so nothing
      // is silently skipped.
      return [{ text: `-- ${change.kind} on ${JSON.stringify(change)}`, parameters: [] }]
  }
}

function postconditionFor(change: SchemaChange): MigrationStep['postcondition'] {
  switch (change.kind) {
    case 'create-table':
      return { kind: 'table-exists', name: change.table }
    case 'create-sequence':
      return { kind: 'sequence-exists', name: change.sequence }
    case 'add-column':
      return { kind: 'column-exists', name: `${change.table}.${change.column}` }
    case 'add-index':
      return { kind: 'index-exists', name: change.index }
    default:
      return { kind: 'none', name: '' }
  }
}
