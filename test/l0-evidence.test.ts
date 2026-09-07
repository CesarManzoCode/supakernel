import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
const readJson = <T>(p: string): T => JSON.parse(read(p)) as T

const SHA40 = /^[0-9a-f]{40}$/
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/

interface LockFile<T> {
  schemaVersion: 1
  cutoff: string
  generatedFrom: string
  entries: T[]
}

describe('L0 — vendor-lock evidence', () => {
  it('every lock file has schemaVersion 1, an RFC3339 cutoff and non-empty entries', () => {
    for (const name of ['sources', 'images', 'packages', 'runtimes']) {
      const doc = readJson<LockFile<unknown>>(`vendor-lock/${name}.json`)
      expect(doc.schemaVersion, name).toBe(1)
      expect(Number.isNaN(Date.parse(doc.cutoff)), name).toBe(false)
      expect(doc.entries.length, name).toBeGreaterThan(0)
    }
  })

  it('sources.json: 40-char commit SHA, github URL, license for every entry', () => {
    const doc = readJson<
      LockFile<{ repository: string; url: string; commit: string; license: string }>
    >('vendor-lock/sources.json')
    for (const e of doc.entries) {
      expect(e.commit, e.repository).toMatch(SHA40)
      expect(e.url).toBe(`https://github.com/${e.repository}`)
      expect(e.license.length, e.repository).toBeGreaterThan(0)
    }
  })

  it('images.json: sha256:<64hex> manifest digest for every entry', () => {
    const doc = readJson<LockFile<{ reference: string; digest: string }>>('vendor-lock/images.json')
    for (const e of doc.entries) expect(e.digest, e.reference).toMatch(SHA256_DIGEST)
  })

  it('packages.json: sha512 npm integrity present in pnpm-lock.yaml for every entry', () => {
    const doc = readJson<LockFile<{ name: string; version: string; integrity: string }>>(
      'vendor-lock/packages.json',
    )
    const lock = read('pnpm-lock.yaml')
    for (const e of doc.entries) {
      expect(e.integrity, `${e.name}@${e.version}`).toMatch(NPM_INTEGRITY)
      expect(lock.includes(e.integrity), `${e.name}@${e.version} in pnpm-lock.yaml`).toBe(true)
    }
  })

  it('runtimes.json: 64-hex sha256 and valid URL for every entry', () => {
    const doc = readJson<LockFile<{ id: string; url: string; sha256: string }>>(
      'vendor-lock/runtimes.json',
    )
    for (const e of doc.entries) {
      expect(e.sha256, e.id).toMatch(SHA256_HEX)
      expect(() => new URL(e.url)).not.toThrow()
    }
  })
})

describe('L0 — repository skeleton matches the contract package map', () => {
  const CONTRACT_PACKAGES = [
    'packages/contracts',
    'packages/ports',
    'packages/schema',
    'packages/policy',
    'packages/data',
    'packages/auth',
    'packages/storage',
    'packages/realtime',
    'packages/management',
    'packages/kernel',
    'packages/gateway',
    'packages/db-postgres',
    'packages/db-pglite',
    'packages/db-sqlite',
    'packages/blob-fs',
    'packages/blob-s3',
    'packages/blob-opfs',
    'packages/runtime-node',
    'packages/runtime-bun',
    'packages/runtime-deno',
    'packages/runtime-workers',
    'packages/runtime-browser',
    'packages/runtime-lambda',
    'packages/ports-test',
    'apps/cli',
    'apps/fixture-app',
    'labs/conformance',
    'labs/runtime-matrix',
    'labs/reference-traces',
    'labs/faults',
    'labs/mutation',
    'labs/benchmarks',
    'labs/agent-evals',
    'labs/upstream-evidence',
  ]

  it('every contract package directory exists and has a manifest', () => {
    for (const p of CONTRACT_PACKAGES) {
      const manifest = readJson<{ name: string }>(`${p}/package.json`)
      expect(manifest.name, p).toMatch(/^@supakernel\//)
    }
  })

  it('no workspace package exists outside the contract map (ports-test is the only extra)', () => {
    const found: string[] = []
    for (const group of ['packages', 'apps', 'labs']) {
      for (const name of readdirSync(join(root, group))) {
        if (name === 'README.md') continue
        found.push(`${group}/${name}`)
      }
    }
    for (const p of found) expect(CONTRACT_PACKAGES, `${p} is not in the contract map`).toContain(p)
  })

  it('root files required by contract §30 L0 exist', () => {
    for (const f of [
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'tsconfig.base.json',
      'biome.json',
      '.tool-versions',
      '.npmrc',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'SECURITY.md',
      'CONTRIBUTING.md',
      'AGENTS.md',
      'README.md',
      '.github/workflows/pr.yml',
      '.github/workflows/nightly.yml',
      '.github/workflows/release.yml',
    ]) {
      expect(read(f).length, f).toBeGreaterThan(0)
    }
  })
})

describe('L0 — deterministic evidence + boundaries', () => {
  it('pnpm check:boundaries reports zero violations', () => {
    const out = execFileSync('node', ['scripts/check-boundaries.mts'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(out).toContain('0 violations')
  })

  it('pnpm verify:provenance passes', { timeout: 120_000 }, () => {
    const out = execFileSync('node', ['scripts/verify-provenance.mts'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(out).toContain('PASSED')
  })

  it('LICENSE is Apache-2.0', () => {
    expect(read('LICENSE')).toContain('Apache License')
    expect(read('LICENSE')).toContain('Version 2.0, January 2004')
  })
})
