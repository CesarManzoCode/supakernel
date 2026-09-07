import { type KernelError, kernelError } from '@supakernel/contracts'

/** GoTrue-shaped error body (contract §12). */
export interface AuthErrorBody {
  readonly code: string
  readonly error_code?: string
  readonly msg: string
  readonly message?: string
}

export class AuthError extends Error {
  readonly kernelError: KernelError
  readonly authCode: string
  constructor(ke: KernelError, authCode: string) {
    super(`${ke.code}: ${ke.message}`)
    this.name = 'AuthError'
    this.kernelError = ke
    this.authCode = authCode
  }
}

function make(
  category: KernelError['category'],
  code: string,
  authCode: string,
  message: string,
  httpStatus: number,
): AuthError {
  return new AuthError(
    kernelError({ category, code, message, httpStatus, retryable: false }),
    authCode,
  )
}

type Factory = () => AuthError
type FactoryArg = (arg: string) => AuthError

export const AUTH_ERRORS: {
  invalidCredentials: Factory
  userAlreadyExists: Factory
  weakPassword: Factory
  badJwt: Factory
  sessionNotFound: Factory
  refreshTokenNotFound: Factory
  refreshTokenReused: Factory
  notAdmin: Factory
  userNotFound: Factory
  unsupported: FactoryArg
  validationFailed: FactoryArg
  rateLimited: Factory
  otpExpired: Factory
} = {
  invalidCredentials: () =>
    make(
      'authn',
      'SK_AUTH_INVALID_CREDENTIALS',
      'invalid_credentials',
      'Invalid login credentials',
      400,
    ),
  userAlreadyExists: () =>
    make('conflict', 'SK_AUTH_USER_EXISTS', 'user_already_exists', 'User already registered', 422),
  weakPassword: () =>
    make('input', 'SK_AUTH_WEAK_PASSWORD', 'weak_password', 'Password is too weak', 422),
  badJwt: () => make('authn', 'SK_AUTH_BAD_JWT', 'bad_jwt', 'invalid JWT', 401),
  sessionNotFound: () =>
    make(
      'authn',
      'SK_AUTH_SESSION_NOT_FOUND',
      'session_not_found',
      'Session from session_id claim in JWT does not exist',
      401,
    ),
  refreshTokenNotFound: () =>
    make(
      'authn',
      'SK_AUTH_REFRESH_NOT_FOUND',
      'refresh_token_not_found',
      'Invalid Refresh Token: Not Found',
      400,
    ),
  refreshTokenReused: () =>
    make(
      'authn',
      'SK_AUTH_REFRESH_REUSED',
      'refresh_token_already_used',
      'Invalid Refresh Token: Already Used',
      400,
    ),
  notAdmin: () => make('authz', 'SK_AUTH_NOT_ADMIN', 'not_admin', 'User not allowed', 403),
  userNotFound: () =>
    make('not_found', 'SK_AUTH_USER_NOT_FOUND', 'user_not_found', 'User not found', 404),
  unsupported: (feature: string) =>
    make('capability', 'SK_CAP_AUTH_UNSUPPORTED', 'unsupported', `unsupported: ${feature}`, 400),
  validationFailed: (msg: string) =>
    make('input', 'SK_AUTH_VALIDATION', 'validation_failed', msg, 400),
  rateLimited: () =>
    make(
      'rate_limit',
      'SK_AUTH_RATE_LIMIT',
      'over_request_rate_limit',
      'Request rate limit reached',
      429,
    ),
  otpExpired: () =>
    make('authn', 'SK_AUTH_OTP_EXPIRED', 'otp_expired', 'Token has expired or is invalid', 401),
}

export function authErrorBody(err: AuthError): AuthErrorBody {
  return {
    code: String(err.kernelError.httpStatus),
    error_code: err.authCode,
    msg: err.kernelError.message,
    message: err.kernelError.message,
  }
}
