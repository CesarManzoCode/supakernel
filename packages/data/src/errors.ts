import { type KernelError, kernelError } from '@supakernel/contracts'

/**
 * PATCH / DELETE without a filter (contract §11.3). An intentional, published security
 * divergence from PostgREST — never normalized away as parity.
 */
export function filterRequired(method: 'PATCH' | 'DELETE'): KernelError {
  return kernelError({
    category: 'input',
    code: 'SK_DATA_FILTER_REQUIRED',
    message: `${method} requires a row filter`,
    httpStatus: 400,
    hint: 'add at least one filter to scope the operation',
    retryable: false,
  })
}

/** A request touched an unsupported surface (rpc, csv, deep embed, …) — contract §11.2. */
export function dataUnsupported(feature: string): KernelError {
  return kernelError({
    category: 'capability',
    code: 'SK_CAP_DATA_UNSUPPORTED',
    message: `unsupported: ${feature}`,
    httpStatus: 400,
    hint: 'this operation is outside the SupaKernel Data subset (contract §11.2)',
    retryable: false,
  })
}

/** Cardinality mismatch for `.single()` / `.maybeSingle()` — PostgREST `PGRST116`. */
export function cardinality(expected: string, got: number): KernelError {
  return kernelError({
    category: 'conflict',
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
    httpStatus: 406,
    details: `results contain ${got} rows, ${expected} expected`,
    retryable: false,
  })
}

export function malformedFilter(detail: string): KernelError {
  return kernelError({
    category: 'input',
    code: 'SK_DATA_MALFORMED_FILTER',
    message: `malformed filter: ${detail}`,
    httpStatus: 400,
    retryable: false,
  })
}

export function unknownRelation(
  kind: 'table' | 'column' | 'relationship',
  name: string,
): KernelError {
  return kernelError({
    category: 'not_found',
    code: kind === 'column' ? 'PGRST204' : 'PGRST205',
    message: `could not find the '${name}' ${kind} in the schema cache`,
    httpStatus: 404,
    retryable: false,
  })
}

export class DataError extends Error {
  readonly kernelError: KernelError
  constructor(ke: KernelError) {
    super(`${ke.code}: ${ke.message}`)
    this.name = 'DataError'
    this.kernelError = ke
  }
}

export function dataError(ke: KernelError): DataError {
  return new DataError(ke)
}
