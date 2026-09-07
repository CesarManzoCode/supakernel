import { type KernelError, kernelError } from '@supakernel/contracts'

/**
 * Map a raw SQLite failure to a `KernelError` category (contract §8, §9.3). Constraint names
 * are surfaced (the comparator may re-map generated names) but values are never echoed.
 */
export function mapSqliteError(err: unknown): KernelError {
  const message = err instanceof Error ? err.message : String(err)
  const code = extractCode(message)

  if (/UNIQUE constraint failed/i.test(message) || code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return kernelError({
      category: 'conflict',
      code: 'SK_DB_UNIQUE_VIOLATION',
      message: 'unique constraint violation',
      httpStatus: 409,
      details: { constraint: constraintFrom(message) },
      retryable: false,
    })
  }
  if (/FOREIGN KEY constraint failed/i.test(message) || code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return kernelError({
      category: 'conflict',
      code: 'SK_DB_FK_VIOLATION',
      message: 'foreign key constraint violation',
      httpStatus: 409,
    })
  }
  if (/NOT NULL constraint failed/i.test(message) || code === 'SQLITE_CONSTRAINT_NOTNULL') {
    return kernelError({
      category: 'input',
      code: 'SK_DB_NOT_NULL_VIOLATION',
      message: 'not-null constraint violation',
      httpStatus: 400,
      details: { column: constraintFrom(message) },
    })
  }
  if (/CHECK constraint failed/i.test(message) || code === 'SQLITE_CONSTRAINT_CHECK') {
    return kernelError({
      category: 'input',
      code: 'SK_DB_CHECK_VIOLATION',
      message: 'check constraint violation',
      httpStatus: 400,
      details: { constraint: constraintFrom(message) },
    })
  }
  if (/no such table/i.test(message)) {
    return kernelError({
      category: 'not_found',
      code: 'SK_DB_UNKNOWN_TABLE',
      message: 'unknown table',
      httpStatus: 404,
    })
  }
  if (/no such column/i.test(message)) {
    return kernelError({
      category: 'input',
      code: 'SK_DB_UNKNOWN_COLUMN',
      message: 'unknown column',
      httpStatus: 400,
    })
  }
  if (code === 'SQLITE_BUSY' || /database is locked/i.test(message)) {
    return kernelError({
      category: 'conflict',
      code: 'SK_DB_BUSY',
      message: 'database is busy',
      httpStatus: 409,
      retryable: true,
    })
  }
  return kernelError({
    category: 'internal',
    code: 'SK_DB_INTERNAL',
    message: 'database error',
    httpStatus: 500,
  })
}

function extractCode(message: string): string | null {
  return message.match(/SQLITE_[A-Z_]+/)?.[0] ?? null
}

function constraintFrom(message: string): string | null {
  // "UNIQUE constraint failed: ct_item.label" -> "ct_item.label"
  return message.match(/constraint failed:\s*([A-Za-z0-9_.,\s]+)/)?.[1]?.trim() ?? null
}
