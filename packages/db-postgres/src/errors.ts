import { type KernelError, kernelError } from '@supakernel/contracts'

interface PgError {
  code?: string
  constraint_name?: string
  column_name?: string
  table_name?: string
  message?: string
}

/** Map a PostgreSQL SQLSTATE to a `KernelError` category (contract §8). Values are never echoed. */
export function mapPostgresError(err: unknown): KernelError {
  const e = (err ?? {}) as PgError
  const code = e.code ?? ''
  switch (code) {
    case '23505': // unique_violation
      return kernelError({
        category: 'conflict',
        code: 'SK_DB_UNIQUE_VIOLATION',
        message: 'unique constraint violation',
        httpStatus: 409,
        details: { constraint: e.constraint_name ?? null },
      })
    case '23503': // foreign_key_violation
      return kernelError({
        category: 'conflict',
        code: 'SK_DB_FK_VIOLATION',
        message: 'foreign key constraint violation',
        httpStatus: 409,
        details: { constraint: e.constraint_name ?? null },
      })
    case '23502': // not_null_violation
      return kernelError({
        category: 'input',
        code: 'SK_DB_NOT_NULL_VIOLATION',
        message: 'not-null constraint violation',
        httpStatus: 400,
        details: { column: e.column_name ?? null },
      })
    case '23514': // check_violation
      return kernelError({
        category: 'input',
        code: 'SK_DB_CHECK_VIOLATION',
        message: 'check constraint violation',
        httpStatus: 400,
        details: { constraint: e.constraint_name ?? null },
      })
    case '22P02': // invalid_text_representation
    case '22003': // numeric_value_out_of_range
      return kernelError({
        category: 'input',
        code: 'SK_DB_INVALID_VALUE',
        message: 'invalid value for column type',
        httpStatus: 400,
      })
    case '42P01': // undefined_table
      return kernelError({
        category: 'not_found',
        code: 'SK_DB_UNKNOWN_TABLE',
        message: 'unknown table',
        httpStatus: 404,
      })
    case '42703': // undefined_column
      return kernelError({
        category: 'input',
        code: 'SK_DB_UNKNOWN_COLUMN',
        message: 'unknown column',
        httpStatus: 400,
      })
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return kernelError({
        category: 'conflict',
        code: 'SK_DB_SERIALIZATION_FAILURE',
        message: 'transaction serialization failure',
        httpStatus: 409,
        retryable: true,
      })
    default:
      return kernelError({
        category: 'internal',
        code: 'SK_DB_INTERNAL',
        message: 'database error',
        httpStatus: 500,
      })
  }
}
