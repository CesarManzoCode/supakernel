import { type KernelError, kernelError } from '@supakernel/contracts'

/** Authorization denial. Carries no row values, no SQL, no claim contents (contract §13.1, §25). */
export function policyDenied(detail: string): KernelError {
  return kernelError({
    category: 'authz',
    code: 'SK_POLICY_DENIED',
    message: 'not authorized',
    httpStatus: 403,
    hint: detail,
    retryable: false,
  })
}

/** A field was read or written that no applicable grant permits (contract §13.1). */
export function fieldForbidden(field: string, mode: 'read' | 'write'): KernelError {
  return kernelError({
    category: 'authz',
    code: mode === 'read' ? 'SK_POLICY_FIELD_UNREADABLE' : 'SK_POLICY_FIELD_UNWRITABLE',
    message: `field "${field}" is not ${mode === 'read' ? 'readable' : 'writable'} for this role`,
    httpStatus: 403,
    retryable: false,
  })
}

/** A policy rule references something outside the portable model (contract §13.1). */
export function policyInvalid(detail: string): KernelError {
  return kernelError({
    category: 'capability',
    code: 'SK_POLICY_INVALID',
    message: `policy rule is invalid: ${detail}`,
    httpStatus: 422,
    retryable: false,
  })
}

/** A `WITH CHECK` failed: the resulting row is not permitted (contract §13.1). */
export function checkViolation(): KernelError {
  return kernelError({
    category: 'authz',
    code: 'SK_POLICY_CHECK_VIOLATION',
    message: 'the resulting row violates a write policy',
    httpStatus: 403,
    retryable: false,
  })
}
