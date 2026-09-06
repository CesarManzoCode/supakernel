/**
 * Shared helpers for the vendor-lock scripts. Node-only build tooling (contract §33.1):
 * this file never ships in a runtime package.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const repoRoot: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SHA40: RegExp = /^[0-9a-f]{40}$/
export const SHA256_DIGEST: RegExp = /^sha256:[0-9a-f]{64}$/
export const SHA256_HEX: RegExp = /^[0-9a-f]{64}$/
export const NPM_INTEGRITY: RegExp = /^sha512-[A-Za-z0-9+/]+={0,2}$/

export interface SourceLock {
  repository: string
  url: string
  ref: string
  commit: string
  license: string
  language: string
  cutoff: string
}

export interface ImageLock {
  reference: string
  registry: string
  repository: string
  tag: string
  digest: string
}

export interface PackageLock {
  name: string
  version: string
  resolved: string
  integrity: string
  publishedAt: string
  license: string
}

export interface RuntimeLock {
  id: string
  version: string
  url: string
  sha256: string
}

export interface VendorLockFile<T> {
  schemaVersion: 1
  generatedFrom: string
  cutoff: string
  entries: readonly T[]
}

/** RFC3339 evidence cutoff from the contract header. */
export const EVIDENCE_CUTOFF = '2026-09-05T00:00:00Z'

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, sortKeys, 2)}\n`
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(record).sort()) out[k] = record[k]
    return out
  }
  return value
}

export async function gh(pathAndQuery: string): Promise<unknown> {
  const { stdout } = await execFileAsync('gh', ['api', pathAndQuery, '--cache', '1h'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout) as unknown
}

function normalizeLicense(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'type' in value) {
    return String((value as { type: unknown }).type)
  }
  return 'NOASSERTION'
}

const npmTimeCache = new Map<string, Record<string, string>>()

async function npmView(args: readonly string[]): Promise<unknown> {
  const { stdout } = await execFileAsync('npm', ['view', ...args, '--json'], {
    maxBuffer: 256 * 1024 * 1024,
  })
  return JSON.parse(stdout) as unknown
}

export async function npmPublishTime(name: string, version: string): Promise<string> {
  let times = npmTimeCache.get(name)
  if (!times) {
    times = (await npmView([name, 'time'])) as Record<string, string>
    npmTimeCache.set(name, times)
  }
  const t = times[version]
  if (!t) throw new Error(`npm ${name}@${version}: no publish timestamp`)
  return t
}

export async function npmVersionMeta(
  name: string,
  version: string,
): Promise<{ resolved: string; integrity: string; publishedAt: string; license: string }> {
  const manifest = (await npmView([`${name}@${version}`])) as {
    dist?: { tarball?: string; integrity?: string }
    license?: unknown
  }
  const integrity = manifest.dist?.integrity
  const resolved = manifest.dist?.tarball
  if (!integrity || !resolved) {
    throw new Error(`npm ${name}@${version}: missing dist.integrity / dist.tarball`)
  }
  const publishedAt = await npmPublishTime(name, version)
  return { resolved, integrity, publishedAt, license: normalizeLicense(manifest.license) }
}

export async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return res.ok
  } catch {
    return false
  }
}

export async function readText(rel: string): Promise<string> {
  return readFile(join(repoRoot, rel), 'utf8')
}

export async function collectWorkspaceDependencies(): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync(
    'node',
    [
      '-e',
      `const {globSync}=require('node:fs');` +
        `const fs=require('node:fs');` +
        `const paths=['package.json',...globSync('{packages,apps,labs}/*/package.json',{cwd:process.cwd()})];` +
        `const out={};for(const p of paths){const j=JSON.parse(fs.readFileSync(p,'utf8'));` +
        `for(const field of ['dependencies','devDependencies','optionalDependencies']){` +
        `const d=j[field]||{};for(const [k,v] of Object.entries(d)){` +
        `if(typeof v==='string'&&!v.startsWith('workspace:')&&!v.startsWith('catalog:'))out[k]=v;}}}` +
        `process.stdout.write(JSON.stringify(out));`,
    ],
    { cwd: repoRoot },
  )
  const raw = JSON.parse(stdout) as Record<string, string>
  return new Map(Object.entries(raw))
}
