import type {
  CheckConstraint,
  Column,
  Expr,
  ForeignKey,
  Index,
  ProjectSchema,
  Sequence,
  Table,
  UniqueConstraint,
} from '@supakernel/contracts'
import { stableKey } from './stable-key.js'

/**
 * Produce the canonical form of a `SchemaIR` (contract §17.1, §30 L3). Two schemas that are
 * semantically equal in the portable subset normalize to byte-identical JSON, so
 * `hashSchema` and `diff` are deterministic regardless of declaration order.
 */
export function normalizeSchema(schema: ProjectSchema): ProjectSchema {
  return {
    version: 1,
    tables: [...schema.tables].map(normalizeTable).sort((a, b) => a.name.localeCompare(b.name)),
    sequences: [...schema.sequences]
      .map(normalizeSequence)
      .sort((a, b) => a.name.localeCompare(b.name)),
    policies: [...schema.policies].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function normalizeTable(table: Table): Table {
  return {
    name: table.name,
    columns: [...table.columns].map(normalizeColumn),
    primaryKey: [...table.primaryKey],
    uniques: [...table.uniques]
      .map(normalizeUnique)
      .sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(','))),
    foreignKeys: [...table.foreignKeys]
      .map(normalizeForeignKey)
      .sort((a, b) => fkKey(a).localeCompare(fkKey(b))),
    checks: [...table.checks]
      .map(normalizeCheck)
      .sort((a, b) => stableKey(a.expr).localeCompare(stableKey(b.expr))),
    indexes: [...table.indexes]
      .map(normalizeIndex)
      .sort((a, b) => idxKey(a).localeCompare(idxKey(b))),
  }
}

function normalizeColumn(c: Column): Column {
  const base: Column = {
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    default: c.default,
    generated: c.generated,
  }
  return c.type === 'enum' && c.enumLabels ? { ...base, enumLabels: [...c.enumLabels] } : base
}

function normalizeUnique(u: UniqueConstraint): UniqueConstraint {
  return { name: u.name, columns: [...u.columns] }
}

function normalizeForeignKey(fk: ForeignKey): ForeignKey {
  return {
    name: fk.name,
    columns: [...fk.columns],
    referencesTable: fk.referencesTable,
    referencesColumns: [...fk.referencesColumns],
    onDelete: fk.onDelete,
    onUpdate: fk.onUpdate,
  }
}

function normalizeCheck(c: CheckConstraint): CheckConstraint {
  return { name: c.name, expr: normalizeExpr(c.expr) }
}

function normalizeIndex(i: Index): Index {
  return {
    name: i.name,
    columns: [...i.columns],
    unique: i.unique,
    where: i.where ? normalizeExpr(i.where) : null,
  }
}

function normalizeSequence(s: Sequence): Sequence {
  return {
    name: s.name,
    ownedBy: s.ownedBy,
    start: s.start,
    increment: s.increment,
    min: s.min,
    max: s.max,
    cycle: s.cycle,
  }
}

/** Canonical ordering inside commutative operators; nested logic is flattened. */
export function normalizeExpr(expr: Expr): Expr {
  switch (expr.kind) {
    case 'literal':
    case 'column':
    case 'claim':
    case 'context':
      return expr
    case 'not':
      return { kind: 'not', term: normalizeExpr(expr.term) }
    case 'compare':
      return {
        kind: 'compare',
        op: expr.op,
        left: normalizeExpr(expr.left),
        right: normalizeExpr(expr.right),
      }
    case 'logic': {
      const terms = expr.terms
        .flatMap((t) => {
          const n = normalizeExpr(t)
          return n.kind === 'logic' && n.op === expr.op ? n.terms : [n]
        })
        .sort((a, b) => stableKey(a).localeCompare(stableKey(b)))
      return terms.length === 1 ? (terms[0] as Expr) : { kind: 'logic', op: expr.op, terms }
    }
    default:
      return expr
  }
}

function fkKey(fk: ForeignKey): string {
  return `${fk.columns.join(',')}->${fk.referencesTable}.${fk.referencesColumns.join(',')}`
}

function idxKey(i: Index): string {
  return `${i.unique ? 'u' : 'i'}:${i.columns.join(',')}:${i.where ? stableKey(i.where) : ''}`
}
