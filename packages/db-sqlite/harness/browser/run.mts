/**
 * First-party browser conformance harness (contract §30 L2). Bundles the WebWorker entry,
 * serves it with cross-origin-isolation headers, launches real Chromium (Playwright 1.63.0),
 * spawns a real dedicated WebWorker and runs the shared connection contract suite against
 * both browser profiles: SQLite-WASM + OPFS and PGlite + OPFS persistence.
 *
 *   pnpm test:db:browser
 */
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = join(here, '.dist')
const require = createRequire(import.meta.url)

/** Vendored DB engines are copied whole and loaded relative to the served worker, so their
 *  own `new URL('./x.wasm', import.meta.url)` resolves against the harness server. */
const VENDORS: { spec: string; pkgDir: string; entry: string; dest: string }[] = [
  {
    spec: '@sqlite.org/sqlite-wasm',
    pkgDir: dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')),
    entry: 'dist/index.mjs',
    dest: 'sqlite-wasm',
  },
  {
    spec: '@electric-sql/pglite',
    pkgDir: dirname(require.resolve('@electric-sql/pglite/package.json')),
    entry: 'dist/index.js',
    dest: 'pglite',
  },
]

const vendorExternalPlugin: Plugin = {
  name: 'vendor-external',
  setup(pluginBuild) {
    for (const v of VENDORS) {
      const re = new RegExp(`^${v.spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(/.*)?$`)
      pluginBuild.onResolve({ filter: re }, (args) => ({
        path: `./${v.dest}/${v.entry.replace(/^dist\//, '')}`,
        external: true,
        namespace: 'vendor',
        pluginData: args.path,
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

const PAGE = `<!doctype html><meta charset="utf-8"><title>supakernel browser contract</title>
<script type="module">
  window.__runProfile = (profile) => new Promise((resolve) => {
    const worker = new Worker('./worker.js', { type: 'module' })
    worker.addEventListener('message', (e) => {
      if (e.data && e.data.ready) { worker.postMessage({ profile }); return }
      resolve(e.data)
      worker.terminate()
    })
    worker.addEventListener('error', (e) => resolve({ ok: false, profile, error: String(e.message || e) }))
  })
</script>
<body>ready</body>`

interface CaseResult {
  name: string
  status: 'pass' | 'fail'
  error?: string
}
interface ProfileOutcome {
  ok: boolean
  profile: string
  results?: CaseResult[]
  error?: string
}

async function main(): Promise<void> {
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  for (const v of VENDORS) {
    await cp(join(v.pkgDir, 'dist'), join(outdir, v.dest), { recursive: true })
  }

  await build({
    entryPoints: { worker: join(here, 'worker-entry.ts') },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    sourcemap: false,
    plugins: [vendorExternalPlugin],
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  })

  const server = createServer(async (req, res) => {
    const isolate = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }
    for (const [k, v] of Object.entries(isolate)) res.setHeader(k, v)
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
  const outcomes: ProfileOutcome[] = []
  try {
    const page = await browser.newPage()
    await page.goto(baseUrl)
    for (const profile of ['sqlite-wasm', 'pglite'] as const) {
      const outcome = (await page.evaluate(
        (p) =>
          (
            window as unknown as { __runProfile: (p: string) => Promise<ProfileOutcome> }
          ).__runProfile(p),
        profile,
      )) as ProfileOutcome
      outcomes.push(outcome)
    }
  } finally {
    await browser.close()
    server.close()
  }

  let failed = 0
  for (const o of outcomes) {
    if (!o.ok || !o.results) {
      failed++
      process.stdout.write(`\n✗ ${o.profile}: harness error: ${o.error ?? 'unknown'}\n`)
      continue
    }
    const pass = o.results.filter((r) => r.status === 'pass').length
    process.stdout.write(`\n${o.profile}: ${pass}/${o.results.length} passed\n`)
    for (const r of o.results) {
      if (r.status === 'fail') {
        failed++
        process.stdout.write(`  ✗ ${r.name}\n    ${r.error}\n`)
      }
    }
  }

  if (failed > 0) {
    process.stderr.write(`\nbrowser contract FAILED (${failed})\n`)
    process.exit(1)
  }
  process.stdout.write('\nbrowser contract PASSED (both profiles)\n')
}

await main()
