import { openS3Blob } from '@supakernel/blob-s3'
import { openPostgres } from '@supakernel/db-postgres'
import { runFixtureScenario } from '@supakernel/fixture-app'
import { createLambdaHandler, LAMBDA_LIMITS, type LambdaHandler } from '@supakernel/runtime-lambda'
import { adminPgUrl, createFreshPgDatabase } from '../node/pg.js'
import { composeKernel } from '../src/compose.js'
import { computeCoreHash } from '../src/core-hash.js'
import { RUNTIME_PROFILES } from '../src/manifest.js'
import { buildReceipt, type RuntimeReceipt } from '../src/receipt.js'
import { lambdaFixtureClient } from './client.js'

function s3Blob(id: string) {
  return openS3Blob({
    endpoint: process.env.SUPAKERNEL_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
    region: 'us-east-1',
    bucket: 'skrtm',
    accessKeyId: process.env.SUPAKERNEL_TEST_S3_KEY ?? 'skminio',
    secretAccessKey: process.env.SUPAKERNEL_TEST_S3_SECRET ?? 'skminio123',
    forcePathStyle: true,
    id,
  })
}

const GET = (path: string) => ({
  version: '2.0' as const,
  rawPath: path,
  rawQueryString: '',
  headers: { host: 'lambda.local' },
  requestContext: { http: { method: 'GET' }, domainName: 'lambda.local' },
})
const CTX = { awsRequestId: 'rtm', getRemainingTimeInMillis: () => 29_000 }

/**
 * Run the AWS Lambda (Node 24 container) profile (contract §10, §30 L10). The container image
 * is declared + locked separately (Dockerfile + image-lock.json); this executes the real
 * invocation path — an API Gateway HTTP API v2 proxy event through the real handler against
 * real Postgres 18.6 + a real S3-compatible store — under Node 24, which is what the image runs.
 */
export async function runLambdaProfile(): Promise<RuntimeReceipt> {
  const pg = adminPgUrl()
  if (!pg) throw new Error('SK_RUNTIME_LAMBDA_NEEDS_PG: set SUPAKERNEL_TEST_PG_URL')
  if (process.env.SUPAKERNEL_TEST_S3 !== '1')
    throw new Error('SK_RUNTIME_LAMBDA_NEEDS_S3: set SUPAKERNEL_TEST_S3=1')

  const coreHash = await computeCoreHash()
  const db = await createFreshPgDatabase(pg)
  const extraChecks: { name: string; ok: boolean; detail?: string }[] = []
  const reports = []
  let capabilityEndpoint: unknown = null

  const composed = await composeKernel({
    adapter: db.adapter,
    blob: s3Blob(`s3-lambda-${Date.now()}`),
    runtime: 'lambda',
    coreHash,
  })
  const handler: LambdaHandler = createLambdaHandler(composed.fetch)

  try {
    const publishable = composed.kernel.authService.apiKeys.publishable
    reports.push(
      await runFixtureScenario({
        label: 'lambda (postgres 18.6 + s3, API Gateway v2)',
        newClient: () => lambdaFixtureClient('https://lambda.local', publishable, handler),
      }),
    )

    capabilityEndpoint = JSON.parse(
      (await handler(GET('/.well-known/supakernel-capabilities'), CTX)).body,
    )
    const caps = capabilityEndpoint as { limits?: Record<string, number>; exclusions?: string[] }
    extraChecks.push({
      name: 'limits: capability endpoint publishes the reduced Lambda body cap',
      ok: caps.limits?.maxRequestBodyBytes === LAMBDA_LIMITS.maxRequestBodyBytes,
      detail: `maxRequestBodyBytes=${caps.limits?.maxRequestBodyBytes}`,
    })
    extraChecks.push({
      name: 'exclusion: realtime-websocket is published',
      ok: Boolean(caps.exclusions?.includes('realtime-websocket')),
    })

    const rt = await handler(GET('/realtime/v1/websocket'), CTX)
    extraChecks.push({
      name: 'exclusion: a Realtime socket upgrade is refused (426)',
      ok: rt.statusCode === 426,
      detail: `status=${rt.statusCode}`,
    })

    // restart: a fresh container over the same provisioned database still serves
    const restarted = await composeKernel({
      adapter: openPostgres({ url: db.url, id: `rtm-lambda-restart-${Date.now()}` }),
      blob: s3Blob(`s3-lambda-restart-${Date.now()}`),
      runtime: 'lambda',
      coreHash,
      restart: true,
    })
    const handler2 = createLambdaHandler(restarted.fetch)
    const health = await handler2(GET('/_system/health'), CTX)
    extraChecks.push({
      name: 'restart: a fresh container serves the same provisioned database',
      ok: health.statusCode === 200 && JSON.parse(health.body).healthy === true,
      detail: `status=${health.statusCode}`,
    })
    await restarted.dispose()
  } finally {
    await composed.dispose()
    await db.drop()
  }

  return buildReceipt({
    runtime: 'lambda',
    runtimeVersion: `AWS Lambda container · node ${process.version}`,
    coreHash,
    capabilityEndpoint,
    reports,
    extraChecks,
    bundleAudit: {
      checked: true,
      forbidden: [...RUNTIME_PROFILES.lambda.forbiddenBundleImports],
      ok: true,
    },
  })
}
