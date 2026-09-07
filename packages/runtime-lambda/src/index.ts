/**
 * `@supakernel/runtime-lambda` — AWS Lambda (Node 24 container) profile primitives (contract
 * §10, §30 L10): an API Gateway HTTP API v2 ⇄ Web `fetch` adapter, env parsing and the profile
 * limits. Realtime is excluded. Composition (kernel + gateway + PG + S3) is done by the host
 * container entrypoint.
 */
export const RUNTIME_ID = 'lambda' as const

export { type RuntimeEnv, readRuntimeEnv } from './env.js'
export {
  type ApiGatewayProxyEventV2,
  type ApiGatewayProxyResultV2,
  createLambdaHandler,
  type LambdaContext,
  type LambdaHandler,
  type WebHandler,
} from './handler.js'
export { LAMBDA_LIMITS } from './limits.js'
