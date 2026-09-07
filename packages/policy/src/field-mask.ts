import type { ExpandedRule } from './wildcard.js'

/**
 * Field-level authorization (contract §13.1).
 *
 * > Field policy intersects fields of all restrictives and unions only applicable permissive
 * > grants; immutable always wins.
 *
 * A field is **readable** if it appears in at least one permissive grant's `read` set and in
 * every applicable restrictive's `read` set. A field is **writable** under the same rule for
 * `write`, and additionally must not appear in any applicable rule's `immutable` set.
 *
 * There is no null-masking: an unreadable field is excluded from the projection and an attempt
 * to select or write it is refused, because a `null` would reveal the column's existence and
 * shape (contract §13.1).
 */
export interface FieldMask {
  readonly readable: ReadonlySet<string>
  readonly writable: ReadonlySet<string>
}

export function computeFieldMask(
  permissive: readonly ExpandedRule[],
  restrictive: readonly ExpandedRule[],
  allColumns: readonly string[],
): FieldMask {
  const immutable = new Set<string>()
  for (const r of [...permissive, ...restrictive]) {
    for (const f of r.immutable) immutable.add(f)
  }

  const readable = new Set<string>()
  const writable = new Set<string>()
  for (const col of allColumns) {
    const permittedRead = permissive.some((p) => p.read.has(col))
    const permittedWrite = permissive.some((p) => p.write.has(col))
    const allRestrictiveRead = restrictive.every((r) => r.read.has(col))
    const allRestrictiveWrite = restrictive.every((r) => r.write.has(col))
    if (permittedRead && allRestrictiveRead) readable.add(col)
    if (permittedWrite && allRestrictiveWrite && !immutable.has(col)) writable.add(col)
  }
  return { readable, writable }
}
