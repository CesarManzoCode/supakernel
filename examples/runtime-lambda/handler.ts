/**
 * AWS Lambda (Node 24 container) entrypoint (contract §10, §30 L10). One warm handler is
 * composed on the first invocation and reused. Data / Auth / Storage over Postgres + S3;
 * Realtime is excluded; Management is loopback read-only.
 *
 * Bundled by `scripts/verify-bundles.mts` (esbuild, platform=node) and shipped in the image
 * built from ./Dockerfile (base pinned in ./image-lock.json).
 */
import { openS3Blob } from '@supakernel/blob-s3'
import type { SchemaIR } from '@supakernel/contracts'
import { openPostgres } from '@supakernel/db-postgres'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink, systemClock, webRandom } from '@supakernel/ports'
import {
  createLambdaHandler,
  LAMBDA_LIMITS,
  type LambdaHandler,
  readRuntimeEnv,
} from '@supakernel/runtime-lambda'

// The deployed schema is baked into the image at build time.
import schema from './schema.json' with { type: 'json' }

let warm: LambdaHandler | undefined

async function build(): Promise<LambdaHandler> {
  const env = readRuntimeEnv(process.env)
  const kernel = await KernelInstance.create({
    projectRef: env.projectRef,
    serverSecret: env.serverSecret,
    runtime: 'lambda',
    adapter: openPostgres({ url: env.databaseUrl }),
    blob: openS3Blob({
      endpoint: env.s3.endpoint ?? `https://s3.${env.s3.region}.amazonaws.com`,
      region: env.s3.region,
      bucket: env.s3.bucket,
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
      forcePathStyle: env.s3.forcePathStyle,
    }),
    schema: schema as SchemaIR,
    ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
    limits: LAMBDA_LIMITS,
    services: ['data', 'auth', 'storage'],
    exclusions: ['realtime-websocket', 'local-filesystem-durability'],
    realtimeManagedTables: [],
    management: { loopbackOnly: true, queryEnabled: false },
  })
  const app = createGateway({ kernel, maxBodyBytes: LAMBDA_LIMITS.maxRequestBodyBytes })
  return createLambdaHandler((request) => app.fetch(request))
}

export const handler: LambdaHandler = async (event, context) => {
  warm ??= await build()
  return warm(event, context)
}
