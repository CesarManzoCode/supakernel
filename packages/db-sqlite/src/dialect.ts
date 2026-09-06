import type { PortableType } from '@supakernel/contracts'

/**
 * SQLite physical type mapping (contract §9.2). The physical column type is chosen so that its
 * *affinity* keeps values in the storage class the kernel needs — in particular `int64` and
 * `decimal` land in **TEXT-affinity** columns so the canonical decimal string is never
 * silently coerced to an INTEGER (which would lose precision at the JS driver boundary) and
 * comparisons stay under the dialect's control.
 *
 * The declared type name also encodes the portable type so introspection can recover it
 * losslessly.
 */
// NB: SQLite assigns INTEGER affinity to ANY declared type containing the substring "INT"
// (checked before "TEXT"). So the TEXT-affinity names below deliberately avoid "INT": an
// `int64` column stored under a name like "TEXT_INT64" would silently take INTEGER affinity
// and lose precision at the JS driver boundary. "SK_TEXT_I64" has no "INT" substring.
const TO_SQLITE: Record<PortableType, string> = {
  bool: 'SK_BOOL', // NUMERIC affinity, stores 0/1
  int32: 'INTEGER', // fits IEEE-754 safe range
  int64: 'SK_TEXT_I64', // TEXT affinity — canonical decimal string
  float64: 'REAL',
  decimal: 'SK_TEXT_DEC', // TEXT affinity — canonical decimal string
  text: 'TEXT',
  uuid: 'SK_TEXT_UUID',
  date: 'SK_TEXT_DATE',
  timestamp: 'SK_TEXT_TS',
  timestamptz: 'SK_TEXT_TSTZ',
  json: 'SK_TEXT_JSON', // canonical JSON text
  bytes: 'BLOB',
  enum: 'SK_TEXT_ENUM',
}

const FROM_SQLITE = new Map<string, PortableType>(
  Object.entries(TO_SQLITE).map(([portable, sqlite]) => [
    sqlite.toUpperCase(),
    portable as PortableType,
  ]),
)

export function sqliteTypeFor(type: PortableType): string {
  return TO_SQLITE[type]
}

export function portableTypeForSqlite(declaredType: string): PortableType | null {
  const key = declaredType.trim().toUpperCase()
  const exact = FROM_SQLITE.get(key)
  if (exact) return exact
  // tolerate a bare affinity keyword from a hand-written or migrated schema
  if (key.includes('BOOL')) return 'bool'
  if (key.includes('INT')) return 'int32'
  if (key.includes('CHAR') || key.includes('CLOB') || key === 'TEXT') return 'text'
  if (key.includes('REAL') || key.includes('FLOA') || key.includes('DOUB')) return 'float64'
  if (key.includes('BLOB') || key === '') return 'bytes'
  return null
}

/** Types whose physical value is a canonical decimal string needing numeric-aware SQL. */
export function isDecimalStringType(type: PortableType): boolean {
  return type === 'int64' || type === 'decimal'
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`)
  }
  return `"${name}"`
}

/** Wrap a reference to an int64 / decimal column so comparison and ordering are numeric. */
export function numericRef(columnExpr: string): string {
  return `CAST(${columnExpr} AS NUMERIC)`
}
