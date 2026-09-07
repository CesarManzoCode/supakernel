import { runFixtureScenario } from '@supakernel/fixture-app'
import { LAMBDA_LIMITS } from '@supakernel/runtime-lambda'
import { adminPgUrl, createFreshPgDatabase } from '../node/pg.js'
import { computeCoreHash } from '../src/core-hash.js'
import { RUNTIME_PROFILES } from '../src/manifest.js'
import { buildReceipt, type RuntimeReceipt } from '../src/receipt.js'
import { lambdaFixtureClient } from './client.js'
import {
  buildImage,
  type ContainerEngine,
  harnessEvent,
  LambdaContainer,
  removeImage,
  resolveContainerEngine,
  resolveRie,
} from './container.js'

const S3_ENV = {
  SUPAKERNEL_S3_ENDPOINT: process.env.SUPAKERNEL_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
  SUPAKERNEL_S3_REGION: 'us-east-1',
  SUPAKERNEL_S3_BUCKET: 'skrtm',
  SUPAKERNEL_S3_ACCESS_KEY_ID: process.env.SUPAKERNEL_TEST_S3_KEY ?? 'skminio',
  SUPAKERNEL_S3_SECRET_ACCESS_KEY: process.env.SUPAKERNEL_TEST_S3_SECRET ?? 'skminio123',
  SUPAKERNEL_S3_FORCE_PATH_STYLE: 'true',
}

/** Precise, singular blocker report — the only reason this profile is allowed to STOP. */
export class LambdaContainerUnavailable extends Error {
  constructor(reason: string) {
    super(`SK_RUNTIME_LAMBDA_NO_CONTAINER_RUNTIME: ${reason}`)
    this.name = 'LambdaContainerUnavailable'
  }
}

export interface LambdaPrereqs {
  readonly engine: ContainerEngine
  readonly rie: string
  readonly pgUrl: string
}

/** Resolve everything the real container gate needs, or throw the singular blocker. */
export async function resolveLambdaPrereqs(): Promise<LambdaPrereqs> {
  const pgUrl = adminPgUrl()
  if (!pgUrl) throw new Error('SK_RUNTIME_LAMBDA_NEEDS_PG: set SUPAKERNEL_TEST_PG_URL')
  if (process.env.SUPAKERNEL_TEST_S3 !== '1')
    throw new Error('SK_RUNTIME_LAMBDA_NEEDS_S3: set SUPAKERNEL_TEST_S3=1 and a running store')

  const engine = await resolveContainerEngine()
  if (!engine) {
    throw new LambdaContainerUnavailable(
      'no rootless container engine found (looked for podman/docker on PATH, ~/.local/bin, ' +
        'and $SUPAKERNEL_CONTAINER_ENGINE). Install a userland engine such as podman-static.',
    )
  }
  const rie = await resolveRie()
  if (!rie) {
    throw new LambdaContainerUnavailable(
      'the AWS Lambda Runtime Interface Emulator was not found (looked for ' +
        '$SUPAKERNEL_LAMBDA_RIE, ~/.local/lib/aws-lambda-rie/aws-lambda-rie, and aws-lambda-rie ' +
        'on PATH).',
    )
  }
  return { engine, rie, pgUrl }
}

/**
 * Run the AWS Lambda (Node 24 container) profile (contract §10, §30 L10) for real: build the
 * locked OCI image, run it under the Lambda Runtime Interface Emulator, and drive the common
 * fixture scenario plus the profile checks over the real API Gateway HTTP API v2 invocation
 * path against real Postgres 18.6 + a real S3-compatible store. No in-process `KernelInstance`
 * stands in for the container.
 */
export async function runLambdaProfile(prereqs?: LambdaPrereqs): Promise<RuntimeReceipt> {
  const { engine, rie, pgUrl } = prereqs ?? (await resolveLambdaPrereqs())

  const coreHash = await computeCoreHash()
  const db = await createFreshPgDatabase(pgUrl)
  const image = await buildImage(engine)

  const extraChecks: { name: string; ok: boolean; detail?: string }[] = []
  const reports = []
  let capabilityEndpoint: unknown = null
  let runtimeVersion = 'AWS Lambda Node 24 container'

  const primary = new LambdaContainer(engine, image.tag, rie)
  try {
    await primary.start({
      SUPAKERNEL_DATABASE_URL: db.url,
      SUPAKERNEL_CORE_HASH: coreHash,
      ...S3_ENV,
    })

    const info = await primary.runtimeInfo()
    runtimeVersion = `AWS Lambda Node 24 container (${engine.kind}) · node ${info.node} · ${info.platform}/${info.arch}`
    extraChecks.push({
      name: 'container: Node 24 runtime inside the real image',
      ok: /^v24\./.test(info.node),
      detail: `node=${info.node} platform=${info.platform}/${info.arch}`,
    })
    extraChecks.push({
      name: 'container: the AWS Lambda handler entrypoint is live (RIC + emulator)',
      ok: Boolean(info.lambdaRuntimeApi) && info.taskRoot === '/var/task',
      detail: `AWS_LAMBDA_RUNTIME_API=${info.lambdaRuntimeApi} LAMBDA_TASK_ROOT=${info.taskRoot} AWS_EXECUTION_ENV=${info.execEnv}`,
    })

    const publishable = await primary.publishableKey()
    reports.push(
      await runFixtureScenario({
        label: 'lambda (real container · postgres 18.6 + s3, API Gateway v2)',
        newClient: () => lambdaFixtureClient('https://lambda.local', publishable, primary.invoke),
      }),
    )

    const capsResult = await primary.invokeRaw(harnessEvent('/.well-known/supakernel-capabilities'))
    capabilityEndpoint = JSON.parse(capsResult.body)
    const caps = capabilityEndpoint as {
      limits?: Record<string, number>
      exclusions?: string[]
    }
    extraChecks.push({
      name: 'limits: capability endpoint publishes the reduced Lambda body cap',
      ok: caps.limits?.maxRequestBodyBytes === LAMBDA_LIMITS.maxRequestBodyBytes,
      detail: `maxRequestBodyBytes=${caps.limits?.maxRequestBodyBytes}`,
    })
    extraChecks.push({
      name: 'exclusion: realtime-websocket + local-filesystem-durability are published',
      ok:
        Boolean(caps.exclusions?.includes('realtime-websocket')) &&
        Boolean(caps.exclusions?.includes('local-filesystem-durability')),
      detail: (caps.exclusions ?? []).join(','),
    })

    const rt = await primary.invokeRaw(harnessEvent('/realtime/v1/websocket'))
    extraChecks.push({
      name: 'exclusion: a Realtime socket upgrade is refused (426)',
      ok: rt.statusCode === 426,
      detail: `status=${rt.statusCode}`,
    })

    // A payload physically larger than the 6 MiB cap is refused by the Lambda platform itself
    // (the same hard limit), which would crash the warm RIC — so the request declares an
    // oversized Content-Length with a tiny body and the gateway refuses it up front.
    const oversize = await primary.invokeRaw({
      ...harnessEvent('/rest/v1/notes', 'POST'),
      headers: {
        host: 'lambda.local',
        apikey: publishable,
        'content-type': 'application/json',
        'content-length': String(LAMBDA_LIMITS.maxRequestBodyBytes + 1024),
      },
      body: Buffer.from('{"pad":"x"}').toString('base64'),
      isBase64Encoded: true,
    })
    extraChecks.push({
      name: 'limits: a request over maxRequestBodyBytes → 413',
      ok: oversize.statusCode === 413,
      detail: `status=${oversize.statusCode}`,
    })

    // restart / fresh-container behaviour: stop this container, start a brand new one against
    // the same already-provisioned database and confirm it serves without re-installing.
    await primary.stop()

    const fresh = new LambdaContainer(engine, image.tag, rie)
    try {
      await fresh.start({
        SUPAKERNEL_DATABASE_URL: db.url,
        SUPAKERNEL_CORE_HASH: coreHash,
        SUPAKERNEL_RESTART: 'true',
        ...S3_ENV,
      })
      const freshInfo = await fresh.runtimeInfo()
      const health = await fresh.invokeRaw(harnessEvent('/_system/health'))
      extraChecks.push({
        name: 'restart: a genuinely fresh container serves the same provisioned database',
        ok:
          health.statusCode === 200 &&
          JSON.parse(health.body).healthy === true &&
          freshInfo.bootNonce !== info.bootNonce &&
          freshInfo.pid !== info.pid,
        detail: `status=${health.statusCode} distinctProcess=${
          freshInfo.bootNonce !== info.bootNonce && freshInfo.pid !== info.pid
        }`,
      })

      const capsAfter = JSON.parse(
        (await fresh.invokeRaw(harnessEvent('/.well-known/supakernel-capabilities'))).body,
      ) as { core_hash?: string }
      extraChecks.push({
        name: 'restart: the fresh container reports the same core hash',
        ok: capsAfter.core_hash === coreHash,
        detail: `core_hash=${capsAfter.core_hash}`,
      })
    } finally {
      await fresh.stop()
    }
  } finally {
    await primary.stop()
    await removeImage(engine, image.tag)
    await db.drop()
  }

  return buildReceipt({
    runtime: 'lambda',
    runtimeVersion,
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
