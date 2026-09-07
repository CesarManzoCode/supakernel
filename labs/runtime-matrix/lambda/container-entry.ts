/**
 * The Lambda handler that runs *inside* the real AWS Node 24 container image (contract §10,
 * §30 L10). esbuild bundles this file to `index.mjs`; the Dockerfile copies it into
 * `${LAMBDA_TASK_ROOT}` and `CMD ["index.handler"]` hands it to the AWS Runtime Interface
 * Client. One warm kernel is composed on the first invocation and reused, exactly as a real
 * Lambda execution environment reuses a warm handler.
 *
 * Data / Auth / Storage over Postgres + an S3-compatible store; Realtime WebSocket is
 * excluded; Management is loopback read-only. Composition is the shared `composeKernel` — the
 * same code every other runtime profile uses, so the core hash matches.
 */
import { openS3Blob } from '@supakernel/blob-s3'
import { openPostgres } from '@supakernel/db-postgres'
import {
  type ApiGatewayProxyEventV2,
  type ApiGatewayProxyResultV2,
  createLambdaHandler,
  type LambdaContext,
} from '@supakernel/runtime-lambda'
import { composeKernel } from '../src/compose.js'

/** A per-process nonce: two containers report different values, proving distinct OS processes. */
const BOOT_NONCE = globalThis.crypto.randomUUID()

function env(key: string): string {
  const v = process.env[key]
  if (v === undefined || v === '') throw new Error(`SK_RUNTIME_ENV_MISSING: ${key}`)
  return v
}

interface Warm {
  readonly invoke: (
    event: ApiGatewayProxyEventV2,
    ctx: LambdaContext,
  ) => Promise<ApiGatewayProxyResultV2>
  readonly dispose: () => Promise<void>
}

let warm: Promise<Warm> | undefined

async function boot(): Promise<Warm> {
  const composed = await composeKernel({
    adapter: openPostgres({ url: env('SUPAKERNEL_DATABASE_URL'), id: 'lambda-container' }),
    blob: openS3Blob({
      endpoint: env('SUPAKERNEL_S3_ENDPOINT'),
      region: process.env.SUPAKERNEL_S3_REGION ?? 'us-east-1',
      bucket: env('SUPAKERNEL_S3_BUCKET'),
      accessKeyId: env('SUPAKERNEL_S3_ACCESS_KEY_ID'),
      secretAccessKey: env('SUPAKERNEL_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: process.env.SUPAKERNEL_S3_FORCE_PATH_STYLE !== 'false',
      id: 'lambda-container',
    }),
    runtime: 'lambda',
    ...(process.env.SUPAKERNEL_CORE_HASH ? { coreHash: process.env.SUPAKERNEL_CORE_HASH } : {}),
    ...(process.env.SUPAKERNEL_RESTART === 'true' ? { restart: true } : {}),
  })

  const fetchHandler = (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === '/_harness/keys') {
      return Promise.resolve(
        Response.json({ publishable: composed.kernel.authService.apiKeys.publishable }),
      )
    }
    if (url.pathname === '/_harness/runtime') {
      return Promise.resolve(
        Response.json({
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          bootNonce: BOOT_NONCE,
          // Set by the AWS Runtime Interface Client / Emulator — proves the Lambda path.
          lambdaRuntimeApi: process.env.AWS_LAMBDA_RUNTIME_API ?? null,
          taskRoot: process.env.LAMBDA_TASK_ROOT ?? null,
          execEnv: process.env.AWS_EXECUTION_ENV ?? null,
        }),
      )
    }
    return composed.fetch(request)
  }

  return {
    invoke: createLambdaHandler(fetchHandler),
    dispose: composed.dispose,
  }
}

export const handler = async (
  event: ApiGatewayProxyEventV2,
  context: LambdaContext,
): Promise<ApiGatewayProxyResultV2> => {
  warm ??= boot()
  return (await warm).invoke(event, context)
}
