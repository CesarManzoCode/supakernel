// Bundle-audit entry for the AWS Lambda profile (contract §30 L10).
export { openS3Blob } from '@supakernel/blob-s3'
export { openPostgres } from '@supakernel/db-postgres'
export { createLambdaHandler, LAMBDA_LIMITS, readRuntimeEnv } from '@supakernel/runtime-lambda'
export { composeKernel } from '../src/compose.js'
