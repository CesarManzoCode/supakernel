/**
 * Bundle import audit for the six runtime profiles (contract §10, §30 L10 — "no unreachable
 * incompatible import in bundle", "Node polyfill en Workers/browser" is a refusal). Each
 * profile's real entrypoint is bundled with esbuild for its target platform; the metafile's
 * input list is checked against the profile's `forbiddenBundleImports`, and the bundle byte
 * size is reported as a lightweight SBOM stat.
 *
 *   node scripts/verify-bundles.mts
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { repoRoot } from './lib/evidence.mts'

const NODE_BUILTINS_FORBIDDEN = [
  'node:fs',
  'node:fs/promises',
  'node:net',
  'node:tls',
  'node:child_process',
  'node:http',
  'node:https',
  'node:worker_threads',
  'node:crypto',
]

/** Mirrors `RUNTIME_PROFILES[x].forbiddenBundleImports` in labs/runtime-matrix/src/manifest.ts. */
const FORBIDDEN: Record<string, readonly string[]> = {
  node: [],
  bun: [],
  deno: [],
  workers: [...NODE_BUILTINS_FORBIDDEN, 'ws', 'pg'],
  browser: [...NODE_BUILTINS_FORBIDDEN, 'ws', 'pg'],
  lambda: [],
}

interface Job {
  readonly runtime: keyof typeof FORBIDDEN
  readonly entry: string
  readonly platform: 'node' | 'browser' | 'neutral'
  /** Module specifiers left external (loaded by the host, not bundled). */
  readonly external: readonly string[]
}

const NODE_EXTERNAL = ['ws', 'pg', 'postgres', '@electric-sql/pglite']
const WORKER_EXTERNAL = ['@sqlite.org/sqlite-wasm', '@electric-sql/pglite', 'cloudflare:workers']

const DIR = 'labs/runtime-matrix/bundle-audit'
const JOBS: Job[] = [
  { runtime: 'node', entry: `${DIR}/node.ts`, platform: 'node', external: NODE_EXTERNAL },
  { runtime: 'bun', entry: `${DIR}/bun.ts`, platform: 'node', external: NODE_EXTERNAL },
  { runtime: 'deno', entry: `${DIR}/deno.ts`, platform: 'node', external: NODE_EXTERNAL },
  {
    runtime: 'workers',
    entry: `${DIR}/workers.ts`,
    platform: 'browser',
    external: WORKER_EXTERNAL,
  },
  { runtime: 'lambda', entry: `${DIR}/lambda.ts`, platform: 'node', external: NODE_EXTERNAL },
  {
    runtime: 'browser',
    entry: `${DIR}/browser.ts`,
    platform: 'browser',
    external: WORKER_EXTERNAL,
  },
]

async function audit(job: Job): Promise<string[]> {
  const outfile = join(repoRoot, '.bundle-audit', `${job.runtime}.mjs`)
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, job.entry)],
    outfile,
    bundle: true,
    format: job.platform === 'node' ? 'esm' : 'esm',
    platform: job.platform,
    target: 'es2023',
    metafile: true,
    write: true,
    logLevel: 'silent',
    external: [...job.external],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.json': 'json' },
  })

  const inputs = Object.keys(result.metafile.inputs)
  const forbidden = FORBIDDEN[job.runtime] ?? []
  const violations: string[] = []
  for (const spec of forbidden) {
    const hit = inputs.find(
      (i) =>
        i === spec ||
        i.startsWith(`${spec}/`) ||
        i.includes(`/node_modules/${spec}/`) ||
        (spec.startsWith('node:') && i === spec),
    )
    if (hit) violations.push(`${job.runtime}: forbidden import "${spec}" reachable via ${hit}`)
  }
  // Any bare `node:` builtin in a browser-platform bundle is a violation even if not listed.
  if (job.platform === 'browser') {
    for (const i of inputs) {
      if (i.startsWith('node:') && !violations.some((v) => v.includes(i))) {
        violations.push(`${job.runtime}: Node builtin "${i}" reachable in a browser bundle`)
      }
    }
  }

  const bytes = result.metafile.outputs[Object.keys(result.metafile.outputs)[0] ?? '']?.bytes ?? 0
  process.stdout.write(
    `  ${job.runtime.padEnd(8)} ${job.platform.padEnd(8)} ${(bytes / 1024).toFixed(0).padStart(5)} KiB  ${inputs.length} modules\n`,
  )
  return violations
}

async function main(): Promise<void> {
  await rm(join(repoRoot, '.bundle-audit'), { recursive: true, force: true })
  process.stdout.write('runtime bundle audit (contract §10, §30 L10)\n')
  const violations: string[] = []
  for (const job of JOBS) {
    try {
      violations.push(...(await audit(job)))
    } catch (err) {
      violations.push(`${job.runtime}: bundle failed — ${(err as Error).message}`)
    }
  }
  await rm(join(repoRoot, '.bundle-audit'), { recursive: true, force: true })

  if (violations.length > 0) {
    process.stderr.write(`\nbundle audit FAILED (${violations.length}):\n`)
    for (const v of violations) process.stderr.write(`  - ${v}\n`)
    process.exit(1)
  }
  process.stdout.write('\nbundle audit PASSED (6 profiles, no incompatible reachable import)\n')
}

await main()
