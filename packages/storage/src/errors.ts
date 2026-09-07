import { type KernelError, kernelError } from '@supakernel/contracts'

export class StorageError extends Error {
  readonly kernelError: KernelError
  constructor(ke: KernelError) {
    super(`${ke.code}: ${ke.message}`)
    this.name = 'StorageError'
    this.kernelError = ke
  }
}

function e(
  category: KernelError['category'],
  code: string,
  message: string,
  httpStatus: number,
): StorageError {
  return new StorageError(kernelError({ category, code, message, httpStatus, retryable: false }))
}

export const STORAGE_ERRORS: {
  bucketNotFound: () => StorageError
  bucketExists: () => StorageError
  objectNotFound: () => StorageError
  objectExists: () => StorageError
  notAuthorized: () => StorageError
  integrityFailure: () => StorageError
  tooLarge: () => StorageError
  invalidSignedToken: () => StorageError
  rangeNotSatisfiable: (size: number) => StorageError
  unsupported: (feature: string) => StorageError
} = {
  bucketNotFound: () => e('not_found', 'SK_STORAGE_BUCKET_NOT_FOUND', 'Bucket not found', 404),
  bucketExists: () => e('conflict', 'SK_STORAGE_BUCKET_EXISTS', 'The resource already exists', 409),
  objectNotFound: () => e('not_found', 'SK_STORAGE_OBJECT_NOT_FOUND', 'Object not found', 404),
  objectExists: () => e('conflict', 'SK_STORAGE_OBJECT_EXISTS', 'The resource already exists', 409),
  notAuthorized: () =>
    e('authz', 'SK_STORAGE_NOT_AUTHORIZED', 'new row violates row-level security policy', 403),
  integrityFailure: () =>
    e('integrity', 'SK_STORAGE_INTEGRITY', 'object bytes are missing or corrupt', 500),
  tooLarge: () =>
    e('input', 'SK_STORAGE_TOO_LARGE', 'The object exceeded the maximum allowed size', 413),
  invalidSignedToken: () => e('authn', 'SK_STORAGE_BAD_SIGNED_TOKEN', 'Invalid signature', 400),
  rangeNotSatisfiable: (size: number) =>
    new StorageError(
      kernelError({
        category: 'input',
        code: 'SK_STORAGE_RANGE',
        message: `bytes */${size}`,
        httpStatus: 416,
      }),
    ),
  unsupported: (feature: string) =>
    e('capability', 'SK_CAP_STORAGE_UNSUPPORTED', `unsupported: ${feature}`, 400),
} as const
