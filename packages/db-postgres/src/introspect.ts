import type {
  CheckConstraint,
  Column,
  ColumnDefault,
  ForeignKey,
  ForeignKeyAction,
  Index,
  ObservedSchema,
  PortableType,
  Sequence,
  Table,
  UniqueConstraint,
  UnmodeledObject,
} from '@supakernel/contracts'
import { parsePgCheck, UnsupportedPgCheckError } from './check-parser.js'

/** A minimal query runner both postgres.js and PGlite can satisfy. */
export type PgQuery = (
  text: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

const FK_ACTION: Record<string, ForeignKeyAction> = {
  a: 'no-action',
  r: 'restrict',
  c: 'cascade',
  n: 'set-null',
  d: 'no-action', // SET DEFAULT collapses to NO ACTION in the portable subset
}

function portableType(dataType: string, udtName: string): PortableType | null {
  switch (udtName) {
    case 'bool':
      return 'bool'
    case 'int2':
    case 'int4':
      return 'int32'
    case 'int8':
      return 'int64'
    case 'float4':
    case 'float8':
      return 'float64'
    case 'numeric':
      return 'decimal'
    case 'text':
    case 'varchar':
    case 'bpchar':
      return 'text'
    case 'uuid':
      return 'uuid'
    case 'date':
      return 'date'
    case 'timestamp':
      return 'timestamp'
    case 'timestamptz':
      return 'timestamptz'
    case 'json':
    case 'jsonb':
      return 'json'
    case 'bytea':
      return 'bytes'
    default:
      return dataType === 'USER-DEFINED' ? 'enum' : null
  }
}

function parseDefault(raw: string | null, sequences: Set<string>): ColumnDefault | null {
  if (raw === null) return null
  const d = raw.trim()
  const nextval = d.match(/^nextval\('([^']+)'::regclass\)$/)
  if (nextval) {
    const seq = (nextval[1] ?? '').replace(/^public\./, '').replace(/"/g, '')
    sequences.add(seq)
    return { kind: 'identity', sequence: seq }
  }
  if (/^(now\(\)|CURRENT_TIMESTAMP)$/i.test(d)) return { kind: 'currentTimestamp' }
  if (/^gen_random_uuid\(\)$/i.test(d)) return { kind: 'uuidV4' }
  const str = d.match(/^'(.*)'::(?:text|character varying|uuid|bpchar)$/s)
  if (str) return { kind: 'literal', value: str[1] ?? '' }
  if (/^-?\d+$/.test(d)) return { kind: 'literal', value: Number(d) }
  if (/^-?\d+\.\d+$/.test(d)) return { kind: 'literal', value: Number(d) }
  if (/^(true|false)$/i.test(d)) return { kind: 'literal', value: /true/i.test(d) }
  if (/^NULL$/i.test(d)) return { kind: 'literal', value: null }
  return { kind: 'literal', value: d }
}

/**
 * Introspect a live PostgreSQL database (schema `public`) into normalized `SchemaIR`
 * (contract §9.2, §17.1). Lossless for the portable subset; anything else is reported in
 * `unmodeled`, and a CHECK outside the portable `Expr` grammar is a recorded refusal, never
 * a silent drop.
 */
export async function introspectPostgres(query: PgQuery): Promise<ObservedSchema> {
  const unmodeled: UnmodeledObject[] = []
  const seqNames = new Set<string>()

  const tableRows = await query(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  )

  const tables: Table[] = []
  for (const tr of tableRows) {
    const name = String(tr.name)
    tables.push(await readTable(query, name, seqNames, unmodeled))
  }

  const sequences: Sequence[] = []
  for (const sr of await query(
    `SELECT s.relname AS name,
            format('%s.%s', dt.relname, a.attname) AS owned_by,
            seq.seqstart::text AS start, seq.seqincrement::text AS increment,
            seq.seqmin::text AS min, seq.seqmax::text AS max, seq.seqcycle AS cycle
       FROM pg_sequence seq
       JOIN pg_class s ON s.oid = seq.seqrelid
       JOIN pg_namespace n ON n.oid = s.relnamespace
       LEFT JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
       LEFT JOIN pg_class dt ON dt.oid = d.refobjid
       LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE n.nspname = 'public'
      ORDER BY s.relname`,
  )) {
    sequences.push({
      name: String(sr.name),
      ownedBy: sr.owned_by ? String(sr.owned_by) : null,
      start: String(sr.start),
      increment: String(sr.increment),
      min: String(sr.min),
      max: String(sr.max),
      cycle: sr.cycle === true,
    })
  }

  return {
    version: 1,
    tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
    sequences: sequences.sort((a, b) => a.name.localeCompare(b.name)),
    policies: [],
    observedAt: new Date().toISOString(),
    unmodeled,
  }
}

async function readTable(
  query: PgQuery,
  name: string,
  seqNames: Set<string>,
  unmodeled: UnmodeledObject[],
): Promise<Table> {
  const cols = await query(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            t.typname AS udt_name,
            NOT a.attnotnull AS nullable,
            pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
            a.attgenerated <> '' AS generated,
            t.typtype AS typtype
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [name],
  )

  const columns: Column[] = cols.map((c) => {
    const udt = String(c.udt_name)
    const dataType = String(c.data_type)
    let pt = portableType(dataType, udt)
    if (c.typtype === 'e') pt = 'enum'
    if (pt === null) {
      unmodeled.push({ kind: 'column', name: `${name}.${String(c.name)}`, reason: `type ${udt}` })
    }
    return {
      name: String(c.name),
      type: pt ?? 'text',
      nullable: c.nullable === true,
      default: parseDefault(c.default_expr === null ? null : String(c.default_expr), seqNames),
      generated: c.generated === true,
    }
  })

  const conRows = await query(
    `SELECT con.conname AS name, con.contype AS type,
            pg_get_constraintdef(con.oid) AS def,
            ARRAY(SELECT attname FROM pg_attribute
                   WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
                   ORDER BY array_position(con.conkey, attnum)) AS cols,
            cf.relname AS ref_table,
            ARRAY(SELECT attname FROM pg_attribute
                   WHERE attrelid = con.confrelid AND attnum = ANY(con.confkey)
                   ORDER BY array_position(con.confkey, attnum)) AS ref_cols,
            con.confdeltype AS on_delete, con.confupdtype AS on_update
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class cf ON cf.oid = con.confrelid
      WHERE n.nspname = 'public' AND c.relname = $1
      ORDER BY con.conname`,
    [name],
  )

  let primaryKey: readonly string[] = []
  const uniques: UniqueConstraint[] = []
  const foreignKeys: ForeignKey[] = []
  const checks: CheckConstraint[] = []

  for (const con of conRows) {
    const conName = String(con.name)
    const conCols = (con.cols as string[] | null) ?? []
    switch (String(con.type)) {
      case 'p':
        primaryKey = conCols
        break
      case 'u':
        uniques.push({ name: conName, columns: conCols })
        break
      case 'f':
        foreignKeys.push({
          name: conName,
          columns: conCols,
          referencesTable: String(con.ref_table),
          referencesColumns: (con.ref_cols as string[] | null) ?? [],
          onDelete: FK_ACTION[String(con.on_delete)] ?? 'no-action',
          onUpdate: FK_ACTION[String(con.on_update)] ?? 'no-action',
        })
        break
      case 'c': {
        const def = String(con.def) // e.g. "CHECK ((qty >= 0))"
        const body = def.replace(/^CHECK\s*\(/i, '').replace(/\)\s*$/, '')
        try {
          checks.push({ name: conName, expr: parsePgCheck(body, name) })
        } catch (err) {
          if (err instanceof UnsupportedPgCheckError) {
            unmodeled.push({
              kind: 'constraint',
              name: conName,
              reason: `CHECK outside portable Expr subset: ${body.trim()}`,
            })
          } else throw err
        }
        break
      }
      default:
        unmodeled.push({
          kind: 'constraint',
          name: conName,
          reason: `constraint type ${String(con.type)}`,
        })
    }
  }

  const idxRows = await query(
    `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
            pg_get_indexdef(ix.indexrelid) AS def,
            ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                    FROM generate_subscripts(ix.indkey, 1) AS k) AS cols
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class c ON c.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
      ORDER BY i.relname`,
    [name],
  )
  const indexes: Index[] = []
  for (const idx of idxRows) {
    if (idx.primary === true) continue
    const def = String(idx.def)
    const wherePart = def.match(/\bWHERE\s+(.+)$/i)?.[1]
    let where = null
    if (wherePart) {
      try {
        where = parsePgCheck(wherePart, name)
      } catch (err) {
        if (err instanceof UnsupportedPgCheckError) {
          unmodeled.push({
            kind: 'index',
            name: String(idx.name),
            reason: `partial predicate outside portable Expr subset: ${wherePart}`,
          })
          continue
        }
        throw err
      }
    }
    indexes.push({
      name: String(idx.name),
      columns: ((idx.cols as string[] | null) ?? []).map((c) => c.replace(/"/g, '')),
      unique: idx.unique === true,
      where,
    })
  }

  return { name, columns, primaryKey, uniques, foreignKeys, checks, indexes }
}
