/**
 * Deterministically regenerate vendor-lock/{sources,images,packages,runtimes}.json and
 * THIRD_PARTY_NOTICES.md from real registry / GitHub / OCI evidence.
 *
 * Contract §30 L0: a second run must produce no diff. Node-only build tooling (§33.1).
 *
 *   node scripts/lock-vendors.mts
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectWorkspaceDependencies,
  EVIDENCE_CUTOFF,
  gh,
  type ImageLock,
  npmVersionMeta,
  type PackageLock,
  type RuntimeLock,
  repoRoot,
  type SourceLock,
  stableStringify,
  type VendorLockFile,
} from './lib/evidence.mts'

// --- input set (the only place vendored identifiers are declared) ---

const SOURCES: readonly { repository: string; ref: string; language: string }[] = [
  { repository: 'PostgREST/postgrest', ref: 'v16.1', language: 'haskell' },
  { repository: 'supabase/auth', ref: 'v2.196.0', language: 'go' },
  { repository: 'supabase/storage', ref: 'v1.70.3', language: 'typescript' },
  { repository: 'supabase/realtime', ref: 'v2.129.3', language: 'elixir' },
  {
    repository: 'supabase/evals',
    ref: '14abaf6d3262b4c663a8f754a76c646e2dbbb431',
    language: 'typescript',
  },
  { repository: 'supabase/cli', ref: 'v2.116.0', language: 'typescript' },
  {
    repository: 'CesarManzoCode/supadiff',
    ref: '31c5a1a40c7e98ef5149f73788e0480130c9491a',
    language: 'typescript',
  },
  {
    repository: 'CesarManzoCode/thalyx',
    ref: '0492f72e487e2463b0d7b938365a8b3383364cb9',
    language: 'rust',
  },
]

const GHCR_REGISTRY = 'ghcr.io'
const GHCR_NAMESPACE = 'supabase/cli'
const IMAGES: readonly { repository: string; tag: string }[] = [
  { repository: 'postgres', tag: '17.6.1.165' },
  { repository: 'postgrest', tag: 'v16.1' },
  { repository: 'auth', tag: 'v2.196.0' },
  { repository: 'realtime', tag: 'v2.129.3' },
  { repository: 'storage', tag: 'v1.70.3' },
  { repository: 'edge-runtime', tag: 'v1.74.3' },
  { repository: 'imgproxy', tag: 'v3.8.0' },
  { repository: 'mailpit', tag: 'v1.30.2' },
  { repository: 'pgmeta', tag: 'v0.98.0' },
  { repository: 'studio', tag: '2026.08.17-sha-0c1da8f' },
]

const RUNTIMES: readonly { id: string; version: string; url: string }[] = [
  {
    id: 'node',
    version: '24.20.0',
    url: 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz',
  },
  {
    id: 'bun',
    version: '1.4.1',
    url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.1/bun-linux-x64.zip',
  },
  {
    id: 'deno',
    version: '2.9.6',
    url: 'https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip',
  },
]

// --- helpers ---

async function ghcrToken(repository: string): Promise<string> {
  const scope = `repository:${GHCR_NAMESPACE}/${repository}:pull`
  const res = await fetch(`https://${GHCR_REGISTRY}/token?scope=${encodeURIComponent(scope)}`)
  if (!res.ok) throw new Error(`ghcr token ${repository}: HTTP ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

async function ghcrDigest(repository: string, tag: string): Promise<string> {
  const token = await ghcrToken(repository)
  const res = await fetch(
    `https://${GHCR_REGISTRY}/v2/${GHCR_NAMESPACE}/${repository}/manifests/${tag}`,
    {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
        ].join(','),
      },
    },
  )
  const digest = res.headers.get('docker-content-digest')
  if (!res.ok || !digest) {
    throw new Error(`ghcr manifest ${repository}:${tag}: HTTP ${res.status} digest=${digest}`)
  }
  return digest
}

async function sha256OfUrl(url: string): Promise<string> {
  const cacheDir = join(tmpdir(), 'supakernel-vendor-cache')
  const key = createHash('sha256').update(url).digest('hex')
  const cachePath = join(cacheDir, `${key}.sha256`)
  try {
    return (await readFile(cachePath, 'utf8')).trim()
  } catch {
    /* miss */
  }
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const digest = createHash('sha256').update(buf).digest('hex')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(cachePath, digest)
  return digest
}

async function githubLicense(repository: string): Promise<string> {
  try {
    const data = (await gh(`repos/${repository}/license`)) as {
      license?: { spdx_id?: string } | null
    }
    return data.license?.spdx_id ?? 'NOASSERTION'
  } catch {
    return 'NOASSERTION'
  }
}

async function githubCommit(repository: string, ref: string): Promise<string> {
  const data = (await gh(`repos/${repository}/commits/${ref}`)) as { sha: string }
  return data.sha
}

// --- generators ---

async function buildSources(): Promise<VendorLockFile<SourceLock>> {
  const entries: SourceLock[] = []
  for (const s of SOURCES) {
    const [commit, license] = await Promise.all([
      githubCommit(s.repository, s.ref),
      githubLicense(s.repository),
    ])
    entries.push({
      repository: s.repository,
      url: `https://github.com/${s.repository}`,
      ref: s.ref,
      commit,
      license,
      language: s.language,
      cutoff: EVIDENCE_CUTOFF,
    })
  }
  entries.sort((a, b) => a.repository.localeCompare(b.repository))
  return {
    schemaVersion: 1,
    generatedFrom: 'scripts/lock-vendors.mts',
    cutoff: EVIDENCE_CUTOFF,
    entries,
  }
}

async function buildImages(): Promise<VendorLockFile<ImageLock>> {
  const entries: ImageLock[] = []
  for (const i of IMAGES) {
    const digest = await ghcrDigest(i.repository, i.tag)
    entries.push({
      reference: `${GHCR_REGISTRY}/${GHCR_NAMESPACE}/${i.repository}:${i.tag}`,
      registry: GHCR_REGISTRY,
      repository: `${GHCR_NAMESPACE}/${i.repository}`,
      tag: i.tag,
      digest,
    })
  }
  entries.sort((a, b) => a.reference.localeCompare(b.reference))
  return {
    schemaVersion: 1,
    generatedFrom: 'scripts/lock-vendors.mts',
    cutoff: EVIDENCE_CUTOFF,
    entries,
  }
}

async function buildPackages(): Promise<VendorLockFile<PackageLock>> {
  const deps = await collectWorkspaceDependencies()
  const entries: PackageLock[] = []
  for (const [name, version] of [...deps].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = await npmVersionMeta(name, version)
    entries.push({
      name,
      version,
      resolved: meta.resolved,
      integrity: meta.integrity,
      publishedAt: meta.publishedAt,
      license: meta.license,
    })
  }
  return {
    schemaVersion: 1,
    generatedFrom: 'scripts/lock-vendors.mts',
    cutoff: EVIDENCE_CUTOFF,
    entries,
  }
}

async function buildRuntimes(): Promise<VendorLockFile<RuntimeLock>> {
  const entries: RuntimeLock[] = []
  for (const r of RUNTIMES) {
    entries.push({ id: r.id, version: r.version, url: r.url, sha256: await sha256OfUrl(r.url) })
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return {
    schemaVersion: 1,
    generatedFrom: 'scripts/lock-vendors.mts',
    cutoff: EVIDENCE_CUTOFF,
    entries,
  }
}

function renderThirdPartyNotices(
  packages: VendorLockFile<PackageLock>,
  sources: VendorLockFile<SourceLock>,
): string {
  const rows = packages.entries
    .map((p) => `| \`${p.name}\` | ${p.version} | ${p.license} |`)
    .join('\n')
  const refs = sources.entries
    .map((s) => `| ${s.repository} | ${s.license} | \`${s.commit}\` |`)
    .join('\n')
  return `<!-- GENERATED by scripts/lock-vendors.mts from vendor-lock/. Do not edit by hand. -->
# Third-party notices

SupaKernel depends on the third-party packages below. Each is pinned to an exact version and
recorded with its resolved tarball integrity in \`vendor-lock/packages.json\` and
\`pnpm-lock.yaml\`. Full license texts are distributed inside each package under
\`node_modules/<name>\`.

| Package | Version | License |
|---|---|---|
${rows}

## Referenced implementations (behavioural, not vendored)

Studied for behaviour only. Commit SHAs and licenses are pinned in \`vendor-lock/sources.json\`.
No source is copied.

| Repository | License | Commit |
|---|---|---|
${refs}
`
}

// --- main ---

async function main(): Promise<void> {
  const [sources, images, packages, runtimes] = await Promise.all([
    buildSources(),
    buildImages(),
    buildPackages(),
    buildRuntimes(),
  ])

  await writeFile(join(repoRoot, 'vendor-lock/sources.json'), stableStringify(sources))
  await writeFile(join(repoRoot, 'vendor-lock/images.json'), stableStringify(images))
  await writeFile(join(repoRoot, 'vendor-lock/packages.json'), stableStringify(packages))
  await writeFile(join(repoRoot, 'vendor-lock/runtimes.json'), stableStringify(runtimes))
  await writeFile(
    join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
    renderThirdPartyNotices(packages, sources),
  )

  process.stdout.write(
    `vendor-lock regenerated: ${sources.entries.length} sources, ${images.entries.length} images, ` +
      `${packages.entries.length} packages, ${runtimes.entries.length} runtimes\n`,
  )
}

await main()
