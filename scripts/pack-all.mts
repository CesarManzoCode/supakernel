/**
 * `pnpm pack:all` (contract §26, §31, §30 L14). Packs every workspace package to
 * `release/packs/` and records the tarball sha256 in `release/packs/checksums.txt`. It does
 * NOT publish — the packages stay `private` and the final brand/scope needs human review
 * (§32). The tarballs are consumer-install fodder + release artifacts.
 *
 *   node scripts/pack-all.mts
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
const OUT = join(root, 'release', 'packs')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const groups = ['packages', 'apps']
const packed: { name: string; file: string; sha256: string }[] = []

for (const group of groups) {
  for (const dir of readdirSync(join(root, group)).sort()) {
    const pkgJson = join(root, group, dir, 'package.json')
    if (!existsSync(pkgJson)) continue
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string }
    if (!pkg.name?.startsWith('@supakernel/') && pkg.name !== 'supakernel') continue
    if (pkg.name === '@supakernel/ports-test') continue // test-only
    if (pkg.name === '@supakernel/fixture-app') continue // conformance fixture, not a shipped surface
    process.stdout.write(`  pack ${pkg.name} … `)
    const out = execSync(`pnpm --filter ${pkg.name} pack --pack-destination ${OUT}`, {
      cwd: root,
      encoding: 'utf8',
    })
    const file = out.trim().split('\n').pop()?.trim() ?? ''
    const abs = file.startsWith('/') ? file : join(OUT, file.split('/').pop() ?? '')
    const sha256 = createHash('sha256').update(readFileSync(abs)).digest('hex')
    packed.push({ name: pkg.name, file: abs.replace(`${root}/`, ''), sha256 })
    console.log(sha256.slice(0, 12))
  }
}

writeFileSync(
  join(OUT, 'checksums.txt'),
  `${packed.map((p) => `${p.sha256}  ${p.file.split('/').pop()}`).join('\n')}\n`,
)
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ packed }, null, 2)}\n`)
console.log(`\npacked ${packed.length} package(s) -> ${OUT.replace(`${root}/`, '')}`)
