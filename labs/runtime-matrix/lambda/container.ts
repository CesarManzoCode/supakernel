/**
 * Real-container plumbing for the AWS Lambda (Node 24) runtime profile (contract §10, §30 L10).
 *
 * There is no mock and no in-process shortcut here: the profile is executed by building the
 * locked OCI image (`./Dockerfile`, whose base digest is cross-checked against
 * `examples/runtime-lambda/image-lock.json`) with a rootless container engine, running it
 * under the AWS Lambda Runtime Interface Emulator, and driving it over the real API Gateway
 * HTTP API v2 invocation endpoint. If no real container engine is available the caller must
 * STOP — never fall back to a fake receipt.
 */
import { execFile } from 'node:child_process'
import { access, constants, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {
  ApiGatewayProxyEventV2,
  ApiGatewayProxyResultV2,
  LambdaHandler,
} from '@supakernel/runtime-lambda'
import { build } from 'esbuild'

const execFileP = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''

export interface ContainerEngine {
  readonly bin: string
  readonly kind: 'podman' | 'docker'
  readonly version: string
}

function engineEnv(): NodeJS.ProcessEnv {
  const xdg = process.env.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : '')
  return {
    ...process.env,
    ...(xdg ? { XDG_RUNTIME_DIR: xdg } : {}),
    PATH: `${HOME}/.local/bin:${process.env.PATH ?? ''}`,
  }
}

/** Locate a usable rootless container engine, or `null` if the host genuinely has none. */
export async function resolveContainerEngine(): Promise<ContainerEngine | null> {
  const override = process.env.SUPAKERNEL_CONTAINER_ENGINE
  const candidates = override
    ? [override]
    : [`${HOME}/.local/bin/podman`, 'podman', `${HOME}/.local/bin/docker`, 'docker']
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { env: engineEnv() })
      return {
        bin,
        kind: /docker/i.test(stdout) && !/podman/i.test(stdout) ? 'docker' : 'podman',
        version: stdout.trim(),
      }
    } catch {
      /* try next */
    }
  }
  return null
}

/** Locate the AWS Lambda Runtime Interface Emulator binary, or `null`. */
export async function resolveRie(): Promise<string | null> {
  const explicit = [
    process.env.SUPAKERNEL_LAMBDA_RIE,
    `${HOME}/.local/lib/aws-lambda-rie/aws-lambda-rie`,
  ].filter((p): p is string => Boolean(p))
  for (const p of explicit) {
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      /* next */
    }
  }
  try {
    const { stdout } = await execFileP('sh', ['-c', 'command -v aws-lambda-rie'], {
      env: engineEnv(),
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** esbuild-bundle the container handler to a single ESM file the image will `COPY`. */
export async function buildContainerBundle(outFile: string): Promise<number> {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(here, 'container-entry.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    logLevel: 'silent',
    banner: {
      js: "import{createRequire as __skCreateRequire}from'node:module';import{fileURLToPath as __skF}from'node:url';import{dirname as __skD}from'node:path';const require=__skCreateRequire(import.meta.url);const __filename=__skF(import.meta.url);const __dirname=__skD(__filename);",
    },
  })
  const out = Object.keys(result.metafile.outputs)[0] ?? ''
  return result.metafile.outputs[out]?.bytes ?? 0
}

export interface BuiltImage {
  readonly tag: string
  readonly buildLog: string
}

/**
 * Cross-check the base image digest pinned in `./Dockerfile` against the linux/amd64 manifest
 * digest recorded in `examples/runtime-lambda/image-lock.json` (contract §30 L10 provenance).
 */
export async function verifyBaseImagePin(): Promise<string> {
  const dockerfile = await readFile(join(here, 'Dockerfile'), 'utf8')
  const pinned = /FROM\s+\S+@(sha256:[0-9a-f]{64})/.exec(dockerfile)?.[1]
  const lock = JSON.parse(
    await readFile(join(repoRoot, 'examples/runtime-lambda/image-lock.json'), 'utf8'),
  ) as { base: { platforms: Record<string, string> } }
  const expected = lock.base.platforms['linux/amd64']
  if (!pinned || pinned !== expected) {
    throw new Error(
      `SK_RUNTIME_LAMBDA_IMAGE_PIN_MISMATCH: Dockerfile pins ${pinned}, image-lock linux/amd64 is ${expected}`,
    )
  }
  return pinned
}

/** Build the locked Lambda image with the freshly-bundled handler. */
export async function buildImage(engine: ContainerEngine): Promise<BuiltImage> {
  await verifyBaseImagePin()
  const ctx = await mkdtemp(join(tmpdir(), 'sk-rtm-lambda-img-'))
  try {
    await buildContainerBundle(join(ctx, 'index.mjs'))
    await copyFile(join(here, 'Dockerfile'), join(ctx, 'Dockerfile'))
    const tag = `supakernel-rtm-lambda:${Date.now()}`
    const { stdout, stderr } = await execFileP(
      engine.bin,
      ['build', '--platform', 'linux/amd64', '-t', tag, ctx],
      { env: engineEnv(), timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    )
    return { tag, buildLog: `${stdout}\n${stderr}` }
  } finally {
    await rm(ctx, { recursive: true, force: true })
  }
}

export async function removeImage(engine: ContainerEngine, tag: string): Promise<void> {
  await execFileP(engine.bin, ['rmi', '-f', tag], { env: engineEnv() }).catch(() => undefined)
}

export interface HarnessRuntimeInfo {
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly pid: number
  readonly bootNonce: string
  readonly lambdaRuntimeApi: string | null
  readonly taskRoot: string | null
  readonly execEnv: string | null
}

/** One running Lambda container, invoked over the emulator's HTTP API. */
export class LambdaContainer {
  private name = ''
  private port = 0
  private started = false

  constructor(
    private readonly engine: ContainerEngine,
    private readonly image: string,
    private readonly rie: string,
  ) {}

  get containerName(): string {
    return this.name
  }

  async start(env: Record<string, string>): Promise<void> {
    this.port = await freePort()
    this.name = `sk-rtm-lambda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const args = [
      'run',
      '--rm',
      '-d',
      '--name',
      this.name,
      '--network=host',
      '-v',
      `${this.rie}:/aws-lambda-rie:ro`,
      '--entrypoint',
      '/aws-lambda-rie',
    ]
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    args.push(
      this.image,
      '--runtime-interface-emulator-address',
      `127.0.0.1:${this.port}`,
      '/lambda-entrypoint.sh',
      'index.handler',
    )
    await execFileP(this.engine.bin, args, { env: engineEnv(), timeout: 120_000 })
    this.started = true
    await this.waitReady()
  }

  private async waitReady(): Promise<void> {
    let lastErr = ''
    for (let i = 0; i < 90; i++) {
      try {
        const res = await this.invokeRaw(harnessEvent('/_harness/runtime'))
        if (res.statusCode === 200) return
        lastErr = `status ${res.statusCode}: ${res.body}`
      } catch (err) {
        lastErr = (err as Error).message
      }
      await sleep(1_000)
    }
    throw new Error(
      `SK_RUNTIME_LAMBDA_CONTAINER_NOT_READY after 90s (${lastErr})\n--- container logs ---\n${await this.logs()}`,
    )
  }

  async invokeRaw(event: ApiGatewayProxyEventV2): Promise<ApiGatewayProxyResultV2> {
    const res = await fetch(
      `http://127.0.0.1:${this.port}/2015-03-31/functions/function/invocations`,
      {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'content-type': 'application/json' },
      },
    )
    const text = await res.text()
    if (res.headers.get('x-amz-function-error')) {
      throw new Error(`SK_RUNTIME_LAMBDA_FUNCTION_ERROR: ${text}`)
    }
    return JSON.parse(text) as ApiGatewayProxyResultV2
  }

  /** Matches the `LambdaHandler` shape so the fixture client can drive it unchanged. */
  invoke: LambdaHandler = (event) => this.invokeRaw(event)

  async runtimeInfo(): Promise<HarnessRuntimeInfo> {
    const res = await this.invokeRaw(harnessEvent('/_harness/runtime'))
    return JSON.parse(res.body) as HarnessRuntimeInfo
  }

  async publishableKey(): Promise<string> {
    const res = await this.invokeRaw(harnessEvent('/_harness/keys'))
    return (JSON.parse(res.body) as { publishable: string }).publishable
  }

  async logs(): Promise<string> {
    try {
      const { stdout, stderr } = await execFileP(this.engine.bin, ['logs', this.name], {
        env: engineEnv(),
        maxBuffer: 16 * 1024 * 1024,
      })
      return `${stdout}\n${stderr}`
    } catch {
      return '(logs unavailable)'
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await execFileP(this.engine.bin, ['rm', '-f', this.name], { env: engineEnv() }).catch(
      () => undefined,
    )
    this.started = false
  }
}

export function harnessEvent(path: string, method = 'GET'): ApiGatewayProxyEventV2 {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'lambda.local' },
    requestContext: { http: { method }, domainName: 'lambda.local' },
  }
}

export type { HARNESS_CTX }
