/**
 * Validate every vendor-lock file and the pnpm supply-chain policy.
 *
 * Contract §30 L0 tests + §33.1 age-gate exception rules. Exits non-zero on the first class of
 * failure with a precise message. Node-only build tooling.
 *
 *   node scripts/verify-provenance.mts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  httpOk,
  type ImageLock,
  NPM_INTEGRITY,
  npmPublishTime,
  type PackageLock,
  type RuntimeLock,
  repoRoot,
  SHA40,
  SHA256_DIGEST,
  SHA256_HEX,
  type SourceLock,
  type VendorLockFile,
} from './lib/evidence.mts'

/** Exact pins that a `minimumReleaseAgeExclude` entry is allowed to name (contract §33.1). */
const NORMATIVE_PINS: ReadonlySet<string> = new Set([
  'typescript@6.0.3',
  '@biomejs/biome@2.5.12',
  'vitest@5.0.0',
  '@vitest/runner@5.0.0',
  '@vitest/snapshot@5.0.0',
  '@vitest/expect@5.0.0',
  '@vitest/spy@5.0.0',
  '@vitest/utils@5.0.0',
  '@vitest/pretty-format@5.0.0',
  '@vitest/mocker@5.0.0',
  'zod@4.5.4',
  'hono@4.13.7',
  '@hono/node-server@2.1.1',
  'jose@6.2.11',
  'postgres@3.4.9',
  '@electric-sql/pglite@0.5.8',
  '@sqlite.org/sqlite-wasm@3.53.0-build1',
  '@types/emscripten@1.41.6',
  'commander@15.0.0',
  'fast-check@4.9.0',
  'libpg-query@17.7.4',
  'wrangler@4.129.0',
  'playwright@1.63.0',
  'playwright-core@1.63.0',
  '@playwright/test@1.63.0',
  'tsup@8.5.1',
  'openapi-typescript@7.13.0',
  'openapi-fetch@0.17.0',
  '@stryker-mutator/core@10.0.0',
  '@stryker-mutator/vitest-runner@10.0.0',
  'ws@8.21.3',
  'mitata@1.0.34',
  'autocannon@8.0.0',
  '@supabase/supabase-js@2.115.0',
  '@supabase/auth-js@2.115.0',
  '@supabase/storage-js@2.115.0',
  '@supabase/realtime-js@2.115.0',
])

const AGE_GATE_MINUTES = 4320

const failures: string[] = []
function fail(msg: string): void {
  failures.push(msg)
}

async function loadLock<T>(name: string): Promise<VendorLockFile<T>> {
  const text = await readFile(join(repoRoot, 'vendor-lock', name), 'utf8')
  const doc = JSON.parse(text) as VendorLockFile<T>
  if (doc.schemaVersion !== 1) fail(`${name}: schemaVersion must be 1`)
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    fail(`${name}: entries must be a non-empty array`)
  }
  if (typeof doc.cutoff !== 'string' || Number.isNaN(Date.parse(doc.cutoff))) {
    fail(`${name}: cutoff must be an RFC3339 timestamp`)
  }
  return doc
}

async function checkSources(): Promise<void> {
  const doc = await loadLock<SourceLock>('sources.json')
  for (const e of doc.entries) {
    if (!SHA40.test(e.commit))
      fail(`sources: ${e.repository} commit is not a 40-char sha: ${e.commit}`)
    if (e.url !== `https://github.com/${e.repository}`) {
      fail(`sources: ${e.repository} url mismatch`)
    }
    if (!e.license || e.license.length === 0) fail(`sources: ${e.repository} missing license`)
    if (!(await httpOk(e.url)))
      fail(`sources: ${e.repository} repository URL is not publicly reachable`)
  }
}

async function checkImages(): Promise<void> {
  const doc = await loadLock<ImageLock>('images.json')
  for (const e of doc.entries) {
    if (!SHA256_DIGEST.test(e.digest))
      fail(`images: ${e.reference} digest is not sha256:<64hex>: ${e.digest}`)
    if (e.reference !== `${e.registry}/${e.repository}:${e.tag}`) {
      fail(`images: ${e.reference} reference/registry/repository/tag inconsistent`)
    }
  }
}

async function checkRuntimes(): Promise<void> {
  const doc = await loadLock<RuntimeLock>('runtimes.json')
  for (const e of doc.entries) {
    if (!SHA256_HEX.test(e.sha256)) fail(`runtimes: ${e.id} sha256 is not 64 hex chars`)
    try {
      // eslint-disable-next-line no-new
      new URL(e.url)
    } catch {
      fail(`runtimes: ${e.id} url is not a valid URL`)
    }
  }
}

async function checkPackages(lockYaml: string): Promise<void> {
  const doc = await loadLock<PackageLock>('packages.json')
  for (const e of doc.entries) {
    if (!NPM_INTEGRITY.test(e.integrity))
      fail(`packages: ${e.name}@${e.version} integrity is not sha512-…`)
    if (Number.isNaN(Date.parse(e.publishedAt)))
      fail(`packages: ${e.name}@${e.version} publishedAt invalid`)
    if (!lockYaml.includes(e.integrity)) {
      fail(`packages: ${e.name}@${e.version} integrity absent from pnpm-lock.yaml`)
    }
  }
}

async function checkAgeGateExceptions(lockYaml: string): Promise<void> {
  const workspace = await readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const block = workspace.match(/minimumReleaseAgeExclude:\s*\n((?:\s*-\s*.*\n?)*)/)
  const blockBody: string = block?.[1] ?? ''
  const selectors: string[] = [...blockBody.matchAll(/-\s*["']?([^"'\n]+)["']?/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((s) => s.length > 0)

  // Age-gate window is anchored to when the lockfile was created.
  const lockMeta = await readFile(join(repoRoot, 'pnpm-lock.yaml.meta.json'), 'utf8').catch(
    () => '',
  )
  const lockCreatedAt = lockMeta ? (JSON.parse(lockMeta) as { createdAt: string }).createdAt : null
  if (!lockCreatedAt) {
    fail('pnpm-lock.yaml.meta.json missing { createdAt } — cannot anchor the age-gate window')
    return
  }
  const anchor = Date.parse(lockCreatedAt)

  for (const sel of selectors) {
    const at = sel.lastIndexOf('@')
    const name = sel.slice(0, at)
    const version = sel.slice(at + 1)
    if (!name || !version || sel.includes('*') || /[\^~><=]/.test(version)) {
      fail(`age-gate: "${sel}" is not a bare package@exact-version selector`)
      continue
    }
    if (!NORMATIVE_PINS.has(sel)) {
      fail(`age-gate: "${sel}" is not a normative contract pin`)
      continue
    }
    let publishedAt: string
    try {
      publishedAt = await npmPublishTime(name, version)
    } catch (err) {
      fail(`age-gate: "${sel}" ${(err as Error).message}`)
      continue
    }
    const ageMinutes = (anchor - Date.parse(publishedAt)) / 60_000
    if (ageMinutes >= AGE_GATE_MINUTES) {
      fail(
        `age-gate: "${sel}" was already ${Math.round(ageMinutes)} min old at lock creation ` +
          `(>= ${AGE_GATE_MINUTES}); the exception is unnecessary and must be removed`,
      )
    }
    if (!lockYaml.includes(`${name}@${version}`)) {
      fail(`age-gate: "${sel}" is excluded but not present in pnpm-lock.yaml`)
    }
  }
}

async function main(): Promise<void> {
  const lockYaml = await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8').catch(() => {
    fail('pnpm-lock.yaml not found — run `corepack pnpm install` first')
    return ''
  })

  await checkSources()
  await checkImages()
  await checkRuntimes()
  if (lockYaml) {
    await checkPackages(lockYaml)
    await checkAgeGateExceptions(lockYaml)
  }

  if (failures.length > 0) {
    process.stderr.write(`provenance verification FAILED (${failures.length}):\n`)
    for (const f of failures) process.stderr.write(`  - ${f}\n`)
    process.exit(1)
  }
  process.stdout.write('provenance verification PASSED\n')
}

await main()
