import type { ProjectSchema, SqlStatement, Table } from '@supakernel/contracts'
import { createIndexStatement, createTableStatement } from './dialects/sqlite.js'

/**
 * SQLite shadow-table rebuild (contract §17.1): SQLite cannot drop a column that participates
 * in an index / FK, change a column type, or change the primary key with a simple `ALTER
 * TABLE`. The portable path is the 12-step procedure — build a new table with the desired
 * shape, copy the columns that still exist, swap, then recreate indexes.
 *
 * The caller runs these inside the migration transaction with foreign-key enforcement
 * suspended and re-checks integrity afterwards.
 */
export function sqliteRebuildStatements(
  desired: ProjectSchema,
  fromTable: Table,
  toTable: Table,
): SqlStatement[] {
  const shadow = `__sk_rebuild_${toTable.name}`
  const fromCols = new Set(fromTable.columns.map((c) => c.name))
  const common = toTable.columns.filter((c) => fromCols.has(c.name)).map((c) => `"${c.name}"`)

  const shadowTable: Table = { ...toTable, name: shadow, indexes: [] }
  const q = (id: string): string => `"${id}"`

  const stmts: SqlStatement[] = [
    createTableStatement(desired, shadowTable),
    {
      text:
        common.length > 0
          ? `INSERT INTO ${q(shadow)} (${common.join(', ')}) SELECT ${common.join(', ')} FROM ${q(fromTable.name)}`
          : `-- no columns carried over from ${fromTable.name}`,
      parameters: [],
    },
    { text: `DROP TABLE ${q(fromTable.name)}`, parameters: [] },
    { text: `ALTER TABLE ${q(shadow)} RENAME TO ${q(toTable.name)}`, parameters: [] },
  ]
  for (const idx of toTable.indexes) stmts.push(createIndexStatement(toTable, idx))
  return stmts.filter((s) => !s.text.trim().startsWith('--'))
}

/** The kinds of change that force a SQLite table rebuild rather than a simple ALTER. */
export const SQLITE_REBUILD_KINDS: ReadonlySet<string> = new Set([
  'drop-column',
  'alter-column',
  'set-primary-key',
  'drop-check',
  'drop-unique',
  'add-foreign-key',
  'drop-foreign-key',
])
