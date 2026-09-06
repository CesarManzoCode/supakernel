import type { Json } from './json.ts'

export type KernelErrorCategory =
  | 'input'
  | 'authn'
  | 'authz'
  | 'conflict'
  | 'not_found'
  | 'capability'
  | 'integrity'
  | 'rate_limit'
  | 'internal'

export const KERNEL_ERROR_CATEGORIES: readonly KernelErrorCategory[] = [
  'input',
  'authn',
  'authz',
  'conflict',
  'not_found',
  'capability',
  'integrity',
  'rate_limit',
  'internal',
]

/**
 * The single error currency of the kernel (contract §8). Codecs map this to the
 * PostgREST / GoTrue / Storage shape; services never throw ad-hoc objects.
 */
export interface KernelError {
  readonly category: KernelErrorCategory
  readonly code: string
  readonly message: string
  readonly details: Json | null
  readonly hint: string | null
  readonly httpStatus: number
  readonly retryable: boolean
  readonly causeId?: string
}

export class KernelErrorException extends Error {
  readonly kernelError: KernelError
  constructor(kernelError: KernelError) {
    super(`${kernelError.code}: ${kernelError.message}`)
    this.name = 'KernelErrorException'
    this.kernelError = kernelError
  }
}

export interface KernelErrorInit {
  category: KernelErrorCategory
  code: string
  message: string
  httpStatus: number
  details?: Json | null
  hint?: string | null
  retryable?: boolean
  causeId?: string
}

export function kernelError(init: KernelErrorInit): KernelError {
  const base: KernelError = {
    category: init.category,
    code: init.code,
    message: init.message,
    details: init.details ?? null,
    hint: init.hint ?? null,
    httpStatus: init.httpStatus,
    retryable: init.retryable ?? false,
  }
  return init.causeId === undefined ? base : { ...base, causeId: init.causeId }
}

/**
 * Patterns that must never appear in an error surfaced to a client. Used by the redaction
 * tests (contract §26) and by `redactError`.
 */
const LEAK_PATTERNS: readonly RegExp[] = [
  /\bselect\b[\s\S]*\bfrom\b/i,
  /\binsert\s+into\b/i,
  /\bupdate\b[\s\S]*\bset\b/i,
  /\bdelete\s+from\b/i,
  /\bcreate\s+(table|policy|index)\b/i,
  /\/(home|usr|var|etc|root|tmp)\//,
  /\bat\s+.+:\d+:\d+/, // stack frame
  /sk-pbkdf2-sha256\$/,
  /\bsb_secret_[A-Za-z0-9]+/,
  /\beyJ[A-Za-z0-9_-]{10,}\./, // JWT
]

export function looksLikeLeak(text: string): boolean {
  return LEAK_PATTERNS.some((re) => re.test(text))
}

/**
 * Guarantee a client-safe error. An `internal` error never carries a caller-visible message
 * beyond a generic one and never carries `details`. Any other category whose message or hint
 * trips a leak pattern is scrubbed too.
 */
export function redactError(error: KernelError): KernelError {
  if (error.category === 'internal') {
    return {
      category: 'internal',
      code: error.code.startsWith('SK_') ? error.code : 'SK_INTERNAL',
      message: 'internal error',
      details: null,
      hint: null,
      httpStatus: error.httpStatus >= 500 ? error.httpStatus : 500,
      retryable: error.retryable,
      ...(error.causeId === undefined ? {} : { causeId: error.causeId }),
    }
  }
  const message = looksLikeLeak(error.message) ? `${error.category} error` : error.message
  const hint = error.hint && looksLikeLeak(error.hint) ? null : error.hint
  const details =
    error.details !== null && looksLikeLeak(JSON.stringify(error.details)) ? null : error.details
  if (message === error.message && hint === error.hint && details === error.details) return error
  return { ...error, message, hint, details }
}
