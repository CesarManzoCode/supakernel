import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Packages that make up the portable semantic core — the code every profile shares unchanged. */
const CORE_PACKAGES = [
  'packages/contracts',
  'packages/ports',
  'packages/policy',
  'packages/data',
  'packages/auth',
  'packages/storage',
  'packages/realtime',
  'packages/management',
  'packages/kernel',
  'packages/gateway',
]

async function walk(dir: string, acc: string[]): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return acc
  }
  for (const name of [...names].sort()) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if ((await stat(full)).isDirectory()) await walk(full, acc)
    else if (/\.ts$/.test(name) && !name.endsWith('.d.ts')) acc.push(full)
  }
  return acc
}

/**
 * A deterministic hash of the shared core's source (contract §30 L10 — every receipt carries
 * the same core hash, proving no domain fork per runtime).
 */
export async function computeCoreHash(): Promise<string> {
  const hash = createHash('sha256')
  for (const pkg of CORE_PACKAGES) {
    const files = await walk(join(repoRoot, pkg, 'src'), [])
    for (const file of files.sort()) {
      hash.update(file.slice(repoRoot.length))
      hash.update('\0')
      hash.update(await readFile(file))
      hash.update('\0')
    }
  }
  return `sha256:${hash.digest('hex')}`
}
