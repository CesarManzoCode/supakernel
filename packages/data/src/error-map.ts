import { type KernelError, kernelError, redactError } from '@supakernel/contracts'
import { DataError } from './errors.js'

export { DataError, dataError } from './errors.js'

export function policyDeniedError(): DataError {
  return new DataError(
    kernelError({
      category: 'authz',
      code: 'SK_POLICY_DENIED',
      message: 'not authorized',
      httpStatus: 403,
      retryable: false,
    }),
  )
}

export function checkViolationError(): DataError {
  return new DataError(
    kernelError({
      category: 'authz',
      code: 'SK_POLICY_CHECK_VIOLATION',
      message: 'the resulting row violates a write policy',
      httpStatus: 403,
      retryable: false,
    }),
  )
}

/** PostgREST-shaped error body (contract §11.1). */
export interface PostgrestErrorBody {
  readonly code: string
  readonly message: string
  readonly details: string | null
  readonly hint: string | null
}

const PG_SQLSTATE: Record<string, { code: string; status: number }> = {
  '23505': { code: '23505', status: 409 }, // unique_violation
  '23503': { code: '23503', status: 409 }, // foreign_key_violation
  '23502': { code: '23502', status: 400 }, // not_null_violation
  '23514': { code: '23514', status: 400 }, // check_violation
  '22P02': { code: '22P02', status: 400 }, // invalid_text_representation
  '42501': { code: '42501', status: 403 }, // insufficient_privilege (RLS)
  '42703': { code: '42703', status: 400 }, // undefined_column
  '42P01': { code: '42P01', status: 404 }, // undefined_table
}

/**
 * Map any error thrown during Data handling to a redacted `KernelError` (contract §11.3, §25 —
 * constraint errors never expose sensitive values; `internal` never exposes SQL / stack).
 */
/**
 * The DB adapters raise constraint failures as `SK_DB_*` `KernelError`s. PostgREST surfaces
 * the raw Postgres SQLSTATE as the error `code` (e.g. `23505`), so the compatible Data
 * response must too — the SupaKernel code is remapped here while the message stays redacted
 * (contract §11.1, §11.3).
 */
const ADAPTER_CONSTRAINT_CODE: Record<string, string> = {
  SK_DB_UNIQUE_VIOLATION: '23505',
  SK_DB_FK_VIOLATION: '23503',
  SK_DB_NOT_NULL_VIOLATION: '23502',
  SK_DB_CHECK_VIOLATION: '23514',
}

function remapAdapterConstraint(ke: KernelError): KernelError {
  const sqlstate = ADAPTER_CONSTRAINT_CODE[ke.code]
  if (!sqlstate) return ke
  const m = PG_SQLSTATE[sqlstate] as { code: string; status: number }
  return kernelError({
    category: m.status === 409 ? 'conflict' : m.status === 403 ? 'authz' : 'input',
    code: m.code,
    message: constraintMessage(sqlstate),
    httpStatus: m.status,
    retryable: false,
  })
}

export function toKernelError(err: unknown): KernelError {
  if (err instanceof DataError) return redactError(remapAdapterConstraint(err.kernelError))

  const withKe = err as { kernelError?: KernelError }
  if (withKe.kernelError) return redactError(remapAdapterConstraint(withKe.kernelError))

  const sqlstate = extractSqlState(err)
  if (sqlstate && PG_SQLSTATE[sqlstate]) {
    const m = PG_SQLSTATE[sqlstate] as { code: string; status: number }
    return redactError(
      kernelError({
        category:
          m.status === 409
            ? 'conflict'
            : m.status === 403
              ? 'authz'
              : m.status === 404
                ? 'not_found'
                : 'input',
        code: m.code,
        message: constraintMessage(sqlstate),
        httpStatus: m.status,
        retryable: false,
      }),
    )
  }

  return redactError(
    kernelError({
      category: 'internal',
      code: 'SK_INTERNAL',
      message: 'internal error',
      httpStatus: 500,
      retryable: true,
    }),
  )
}

function extractSqlState(err: unknown): string | null {
  const code = (err as { code?: unknown; cause?: { code?: unknown } }).code
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code
  if (typeof causeCode === 'string' && /^[0-9A-Z]{5}$/.test(causeCode)) return causeCode
  // adapter-mapped: "SK_DB_UNIQUE_VIOLATION: ..." style
  const msg = String((err as { message?: unknown }).message ?? '')
  if (/SK_DB_UNIQUE/.test(msg)) return '23505'
  if (/SK_DB_FOREIGN_KEY/.test(msg)) return '23503'
  if (/SK_DB_NOT_NULL/.test(msg)) return '23502'
  if (/SK_DB_CHECK/.test(msg)) return '23514'
  return null
}

function constraintMessage(sqlstate: string): string {
  switch (sqlstate) {
    case '23505':
      return 'duplicate key value violates unique constraint'
    case '23503':
      return 'insert or update violates foreign key constraint'
    case '23502':
      return 'null value violates not-null constraint'
    case '23514':
      return 'new row violates check constraint'
    case '42501':
      return 'permission denied'
    default:
      return 'request failed'
  }
}

export function toPostgrestBody(ke: KernelError): PostgrestErrorBody {
  return {
    code: ke.code,
    message: ke.message,
    details:
      typeof ke.details === 'string'
        ? ke.details
        : ke.details === null
          ? null
          : JSON.stringify(ke.details),
    hint: ke.hint,
  }
}
