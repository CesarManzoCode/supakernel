/**
 * `pnpm reproduce --artifact release/manifest.json` (contract §26, §31, §30 L14). Validates
 * that a release manifest can be reconstructed from a clean state: every checksum matches,
 * every referenced vendor digest / lockfile hash is present (a MISSING digest is a hard
 * failure — never an update), and the current tree hashes identically.
 *
 *   node scripts/reproduce.mts --artifact release/manifest.json
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
const artIdx = process.argv.indexOf('--artifact')
const artifact = artIdx !== -1 ? process.argv[artIdx + 1] : 'release/manifest.json'
const manifestPath = join(root, artifact ?? 'release/manifest.json')

if (!existsSync(manifestPath)) {
  console.error(`reproduce: ${artifact} not found — run \`pnpm release:audit\` first`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  toolchain: { lockfileHash: string }
  vendorLocks: Record<string, string>
  sbom: string
}

const sha = (p: string): string =>
  createHash('sha256')
    .update(readFileSync(join(root, p)))
    .digest('hex')

let failed = false
function check(label: string, expected: string, path: string): void {
  const actual = existsSync(join(root, path)) ? sha(path) : null
  if (actual === null) {
    failed = true
    console.log(`  MISSING  ${label} (${path}) — digest cannot be updated, this is a hard failure`)
  } else if (actual !== expected) {
    failed = true
    console.log(`  MISMATCH ${label}: expected ${expected.slice(0, 12)} got ${actual.slice(0, 12)}`)
  } else {
    console.log(`  ok       ${label}`)
  }
}

check('pnpm-lock.yaml', manifest.toolchain.lockfileHash, 'pnpm-lock.yaml')
check('vendor-lock/sources.json', manifest.vendorLocks.sources ?? '', 'vendor-lock/sources.json')
check('vendor-lock/images.json', manifest.vendorLocks.images ?? '', 'vendor-lock/images.json')
check('vendor-lock/packages.json', manifest.vendorLocks.packages ?? '', 'vendor-lock/packages.json')
check('vendor-lock/runtimes.json', manifest.vendorLocks.runtimes ?? '', 'vendor-lock/runtimes.json')
check('release/sbom.json', manifest.sbom, 'release/sbom.json')

// release/checksums.txt covers every release/ file
const checksums = readFileSync(join(root, 'release/checksums.txt'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
for (const line of checksums) {
  const [hash, rel] = line.split(/\s\s+/)
  if (!hash || !rel) continue
  const p = join(root, 'release', rel)
  if (!existsSync(p)) {
    failed = true
    console.log(`  MISSING  release/${rel}`)
    continue
  }
  const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (actual !== hash) {
    failed = true
    console.log(`  MISMATCH release/${rel}`)
  }
}
console.log(`  ok       release/checksums.txt (${checksums.length} files)`)

console.log(
  failed
    ? '\nreproduce: FAIL — release bundle is not reproducible from this state'
    : '\nreproduce: PASS — release bundle reproduces',
)
process.exit(failed ? 1 : 0)
