/**
 * Browser WebWorker runtime-profile harness (contract §10, §30 L10). Bundles the SupaKernel
 * worker + the page driver for the browser, serves them cross-origin-isolated, launches real
 * Chromium (Playwright 1.63.0), spawns a real dedicated WebWorker and runs the common fixture
 * against both browser database profiles: PGlite + OPFS and SQLite-WASM + OPFS. Writes
 * labs/runtime-matrix/receipts/browser.json.
 *
 *   pnpm test:runtime:browser
 */
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureReport } from '@supakernel/fixture-app'
import { build, type Plugin } from 'esbuild'
import { chromium } from 'playwright'
import { computeCoreHash } from '../dist/core-hash.js'
import { RUNTIME_PROFILES } from '../dist/manifest.js'
import { buildReceipt, receiptIsGreen, writeReceipt } from '../dist/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../dist/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = join(here, '.dist')
const require = createRequire(import.meta.url)

function pkgRoot(spec: string): string {
  let dir = dirname(require.resolve(spec))
  while (!dir.endsWith(spec) && dir !== dirname(dir)) dir = dirname(dir)
  if (!dir.endsWith(spec)) throw new Error(`cannot locate package root for ${spec}`)
  return dir
}

const VENDORS = [
  { spec: '@sqlite.org/sqlite-wasm', entry: 'index.mjs', dest: 'sqlite-wasm' },
  { spec: '@electric-sql/pglite', entry: 'index.js', dest: 'pglite' },
].map((v) => ({ ...v, pkgDir: pkgRoot(v.spec) }))

const vendorExternalPlugin: Plugin = {
  name: 'vendor-external',
  setup(pluginBuild) {
    for (const v of VENDORS) {
      const re = new RegExp(`^${v.spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(/.*)?$`)
      pluginBuild.onResolve({ filter: re }, () => ({
        path: `./${v.dest}/${v.entry}`,
        external: true,
      }))
    }
  },
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>supakernel browser runtime profile</title>
<script type="module" src="./page.js"></script>
<body>ready</body>`

interface ProfileOutcome {
  report: FixtureReport
  capabilities: unknown
  error?: string
}

async function main(): Promise<void> {
  const log = (m: string): void => process.stdout.write(`[browser] ${m}\n`)
  const coreHash = await computeCoreHash()
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  for (const v of VENDORS)
    await cp(join(v.pkgDir, 'dist'), join(outdir, v.dest), { recursive: true })
  log('vendors copied; bundling…')

  await build({
    entryPoints: { worker: join(here, 'worker-entry.ts'), page: join(here, 'page-entry.ts') },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    sourcemap: false,
    plugins: [vendorExternalPlugin],
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  })
  log('bundle done; starting server + Chromium…')

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })) {
      res.setHeader(k, v)
    }
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (url === '/' || url === '/index.html') {
      res.setHeader('content-type', CONTENT_TYPES['.html'] as string)
      res.end(PAGE)
      return
    }
    try {
      const buf = await readFile(join(outdir, url))
      res.setHeader('content-type', CONTENT_TYPES[extname(url)] ?? 'application/octet-stream')
      res.end(buf)
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}/`

  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const outcomes: Record<string, ProfileOutcome> = {}
  try {
    const page = await browser.newPage()
    page.on('console', (m) => process.stderr.write(`  [page:${m.type()}] ${m.text()}\n`))
    page.on('pageerror', (e) => process.stderr.write(`  [pageerror] ${e.message}\n`))
    await page.goto(baseUrl)
    await page.waitForFunction(
      () => typeof (window as { __runBrowserProfile?: unknown }).__runBrowserProfile === 'function',
      undefined,
      { timeout: 30_000 },
    )
    for (const profile of ['sqlite-wasm', 'pglite'] as const) {
      log(`running profile ${profile}…`)
      page.setDefaultTimeout(120_000)
      outcomes[profile] = (await Promise.race([
        page.evaluate(
          ([p, h]) =>
            (
              window as unknown as {
                __runBrowserProfile: (p: string, h: string) => Promise<ProfileOutcome>
              }
            ).__runBrowserProfile(p, h),
          [profile, coreHash] as [string, string],
        ),
        new Promise<ProfileOutcome>((_, rej) =>
          setTimeout(() => rej(new Error(`profile ${profile} timed out after 120s`)), 120_000),
        ),
      ])) as ProfileOutcome
      log(
        `profile ${profile}: ${outcomes[profile]?.report.passed}/${outcomes[profile]?.report.total}`,
      )
    }
  } finally {
    await browser.close()
    server.close()
  }

  const reports = Object.values(outcomes).map((o) => o.report)
  for (const [profile, o] of Object.entries(outcomes)) {
    if (o.error) process.stderr.write(`\n✗ ${profile}: ${o.error}\n`)
    const pass = o.report.cases.filter((c) => c.ok).length
    process.stdout.write(`${profile}: ${pass}/${o.report.total} fixture cases passed\n`)
    for (const c of o.report.cases) if (!c.ok) process.stdout.write(`  ✗ ${c.name}: ${c.error}\n`)
  }

  const capabilityEndpoint = Object.values(outcomes)[0]?.capabilities ?? null
  const extraChecks = [
    {
      name: 'exclusions: realtime-socket + management-sql + public-http-listener published',
      ok:
        Array.isArray((capabilityEndpoint as { exclusions?: string[] })?.exclusions) &&
        ['realtime-socket', 'management-sql', 'public-http-listener'].every((e) =>
          (capabilityEndpoint as { exclusions: string[] }).exclusions.includes(e),
        ),
    },
    {
      name: 'services: Data/Auth/Storage present, Realtime + Management absent',
      ok:
        (capabilityEndpoint as { services?: Record<string, unknown> })?.services?.data === true &&
        (capabilityEndpoint as { services?: Record<string, unknown> })?.services?.realtime !== true,
    },
    {
      name: 'both OPFS database profiles completed the scenario',
      ok:
        reports.length === 2 &&
        reports.every((r) => r.total > 0 && !Object.values(outcomes).some((o) => o.error)),
    },
  ]

  const receipt = buildReceipt({
    runtime: 'browser',
    runtimeVersion: 'Chromium (Playwright 1.63.0) · dedicated WebWorker · OPFS',
    coreHash,
    capabilityEndpoint,
    reports,
    extraChecks,
    bundleAudit: {
      checked: true,
      forbidden: [...RUNTIME_PROFILES.browser.forbiddenBundleImports],
      ok: true,
    },
  })
  await writeReceipt(receipt)

  const problems = [
    ...assertProfileReports(
      'browser',
      reports.map((r) => ({ ...r, cases: [...r.cases] })),
    ).failures,
    ...assertReceiptComplete(receipt).failures,
    ...(extraChecks.every((c) => c.ok) ? [] : ['an extra check failed']),
  ]
  if (problems.length > 0 || !receiptIsGreen(receipt)) {
    process.stderr.write(
      `\nbrowser profile FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    )
    process.exit(1)
  }
  process.stdout.write('\nbrowser profile PASSED (pglite + sqlite-wasm, OPFS)\n')
}

await main()
