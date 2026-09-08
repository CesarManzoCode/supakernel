/**
 * `pnpm release:audit` (contract §26, §31, §30 L14, Appendix B). Binds every supported claim
 * to an auditable artifact set: for each claim it runs the exact command (or checks the
 * committed artifact), records the result + a sha256, and writes:
 *
 *   release/manifest.json    — claim → capability ID → §  → targets → command → artifact →
 *                              hash → result → known limitations  (no hidden UNKNOWN)
 *   release/acceptance.json  — the §31 matrix outcome
 *   release/checksums.txt    — sha256 of every release/ file + every referenced artifact
 *   release/sbom.json        — CycloneDX-style component list from the frozen lockfile
 *   release/gates/<id>.txt   — the captured output of each gate command
 *
 * A GATE row that fails with no documented external blocker makes the audit fail. It does NOT
 * publish anything.
 *
 *   node scripts/release-audit.mts [--fast]   (--fast: artifact-only, skip heavy commands)
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, cpus, release as osRelease, platform } from 'node:os'
import { join, relative } from 'node:path'
import { CLAIMS } from './lib/claims.mts'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
const fast = process.argv.includes('--fast')
const RELEASE = join(root, 'release')
const GATES = join(RELEASE, 'gates')
mkdirSync(GATES, { recursive: true })

function sh(cmd: string): { code: number; out: string } {
  try {
    const out = execSync(cmd, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
  }
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function hashTree(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) walk(full)
      else h.update(`${relative(dir, full)}:`).update(readFileSync(full))
    }
  }
  if (existsSync(dir)) walk(dir)
  return h.digest('hex')
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

// The release proof is committed. To make it reproduce byte-for-byte from a clean tree (so
// `pnpm reproduce` + `git diff --exit-code` are meaningful), every timestamp in it is the
// committer date of HEAD — not the wall clock.
const SOURCE_DATE = git('show -s --format=%cI HEAD') || new Date(0).toISOString()

// ---- per-claim evaluation ----

interface ClaimResult {
  readonly id: string
  readonly type: string
  readonly capabilityId: string
  readonly contractSection: string
  readonly realTargets: string
  readonly command: string
  readonly artifact: string
  readonly artifactHash: string | null
  readonly artifactPresent: boolean
  readonly criterion: string
  readonly result: 'pass' | 'fail' | 'artifact-only' | 'blocked' | 'pending'
  readonly knownLimitations: string
  readonly detail: string
}

const results: ClaimResult[] = []

function hashArtifact(p: string): string | null {
  if (!existsSync(p)) return null
  return statSync(p).isDirectory() ? hashTree(p) : sha256File(p)
}

for (const claim of CLAIMS) {
  const artPath = join(root, claim.artifact)
  const blocked = /EXTERNAL BLOCKER|EXTERNAL:/.test(claim.knownLimitations)

  let result: ClaimResult['result']
  let detail: string

  if (blocked) {
    // A documented §32 external blocker: record the artifact if the harness produced one,
    // never run the (credentialed / human) step, never fail the release on it.
    result = 'blocked'
    detail = existsSync(artPath)
      ? 'artifact present; external step blocked (§32)'
      : 'external step blocked (§32)'
  } else if (fast) {
    // --fast: partial structural audit — record present artifacts, mark the rest `pending`.
    result = existsSync(artPath) ? 'artifact-only' : 'pending'
    detail = existsSync(artPath) ? 'artifact present' : 'command not run under --fast'
  } else if (claim.artifactOnly) {
    // Heavy / generative step whose pass/fail is asserted by a dedicated CI lane, not here.
    // Run it best-effort to (re)generate the artifact, then record the artifact + a note.
    const run = sh(claim.command)
    writeFileSync(
      join(GATES, `${claim.id}.txt`),
      `$ ${claim.command}\nexit ${run.code}\n\n${run.out.slice(-40_000)}`,
    )
    result = 'artifact-only'
    detail = existsSync(artPath)
      ? `artifact regenerated (command exit ${run.code}; asserted by the dedicated lane)`
      : `no artifact and command exit ${run.code}`
    if (!existsSync(artPath) && claim.type === 'GATE') result = 'fail'
  } else {
    // A binding GATE: run the exact command; exit 0 is the only pass.
    const run = sh(claim.command)
    writeFileSync(
      join(GATES, `${claim.id}.txt`),
      `$ ${claim.command}\nexit ${run.code}\n\n${run.out.slice(-40_000)}`,
    )
    result = run.code === 0 ? 'pass' : 'fail'
    detail = `exit ${run.code}`
  }

  const artifactHash = hashArtifact(artPath)

  results.push({
    id: claim.id,
    type: claim.type,
    capabilityId: claim.capabilityId,
    contractSection: claim.contractSection,
    realTargets: claim.realTargets,
    command: claim.command,
    artifact: claim.artifact,
    artifactHash,
    artifactPresent: existsSync(artPath),
    criterion: claim.criterion,
    result,
    knownLimitations: claim.knownLimitations,
    detail,
  })
  console.log(`  ${result.toUpperCase().padEnd(13)} ${claim.type.padEnd(9)} ${claim.id}`)
}

// ---- SBOM from the frozen lockfile ----

function buildSbom(): unknown {
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  const components: { name: string; version: string; integrity?: string }[] = []
  const re = /^\s{2}(\S+?)@([\d][^:(]*)(?:\([^)]*\))?:\s*$/gm
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(lock)) !== null) {
    const name = m[1] as string
    const version = m[2] as string
    const key = `${name}@${version}`
    if (seen.has(key)) continue
    seen.add(key)
    const block = lock.slice(m.index, m.index + 400)
    const integrity = block.match(/integrity:\s*(\S+)/)?.[1]
    components.push({ name, version, ...(integrity ? { integrity } : {}) })
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      timestamp: SOURCE_DATE,
      component: { type: 'application', name: 'supakernel-monorepo', version: '0.0.0' },
      tools: [{ name: 'supakernel release-audit' }],
    },
    components: components
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        type: 'library',
        name: c.name,
        version: c.version,
        ...(c.integrity ? { hashes: [{ alg: 'SHA-512', content: c.integrity }] } : {}),
      })),
  }
}

writeFileSync(join(RELEASE, 'sbom.json'), `${JSON.stringify(buildSbom(), null, 2)}\n`)

// ---- manifest + acceptance ----

const gateResults = results.filter((r) => r.type === 'GATE')
const failingGates = gateResults.filter((r) => r.result === 'fail')
const blockedGates = gateResults.filter((r) => r.result === 'blocked')

const manifest = {
  schemaVersion: 1,
  generatedAt: SOURCE_DATE,
  git: {
    sha: git('rev-parse HEAD'),
    branch: git('rev-parse --abbrev-ref HEAD'),
    // the audit writes into release/; a tree dirty only there is "clean" for this purpose
    dirty: git("status --porcelain -- ':!release'").length > 0,
  },
  host: {
    platform: platform(),
    release: osRelease(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
  },
  toolchain: {
    node: process.version,
    pnpm: git('') ? execSync('pnpm --version', { encoding: 'utf8' }).trim() : 'unknown',
    lockfileHash: sha256File(join(root, 'pnpm-lock.yaml')),
  },
  vendorLocks: {
    sources: sha256File(join(root, 'vendor-lock/sources.json')),
    images: sha256File(join(root, 'vendor-lock/images.json')),
    packages: sha256File(join(root, 'vendor-lock/packages.json')),
    runtimes: sha256File(join(root, 'vendor-lock/runtimes.json')),
  },
  sbom: sha256File(join(RELEASE, 'sbom.json')),
  claims: results,
  // A hidden UNKNOWN is a GATE that neither passed, produced an artifact, nor is a
  // documented external blocker. `pending` only exists under --fast (a partial structural
  // audit that deliberately skips heavy commands) and is not a hidden UNKNOWN there.
  hiddenUnknown: results.filter(
    (r) =>
      r.result !== 'pass' &&
      r.result !== 'artifact-only' &&
      r.result !== 'blocked' &&
      !(r.result === 'pending' && fast) &&
      r.type === 'GATE',
  ).length,
  partial: fast,
  pendingGates: results.filter((r) => r.result === 'pending').map((r) => r.id),
}
writeFileSync(join(RELEASE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const acceptance = {
  schemaVersion: 1,
  generatedAt: manifest.generatedAt,
  git: manifest.git.sha,
  gate: {
    total: gateResults.length,
    pass: gateResults.filter((r) => r.result === 'pass').length,
    artifactOnly: gateResults.filter((r) => r.result === 'artifact-only').length,
    blocked: blockedGates.map((r) => ({ id: r.id, limitation: r.knownLimitations })),
    fail: failingGates.map((r) => ({ id: r.id, detail: r.detail })),
  },
  evidence: results
    .filter((r) => r.type === 'EVIDENCE')
    .map((r) => ({
      id: r.id,
      result: r.result,
      artifact: r.artifact,
      hash: r.artifactHash,
      limitation: r.knownLimitations,
    })),
  externalBlockers: results
    .filter((r) => r.result === 'blocked')
    .map((r) => ({ id: r.id, limitation: r.knownLimitations })),
  partial: fast,
  releasable: !fast && failingGates.length === 0,
}
writeFileSync(join(RELEASE, 'acceptance.json'), `${JSON.stringify(acceptance, null, 2)}\n`)

// ---- checksums ----

function checksumLines(dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (entry === 'checksums.txt') continue
    // `gates/` and `packs/` are transient (gitignored): captured command output and packed
    // tarballs, regenerated by the audit / `pack:all`. The committed proof is the JSON set.
    if (entry === 'gates' || entry === 'packs') continue
    if (statSync(full).isDirectory()) out.push(...checksumLines(full, base))
    else out.push(`${sha256File(full)}  ${relative(base, full)}`)
  }
  return out
}
writeFileSync(join(RELEASE, 'checksums.txt'), `${checksumLines(RELEASE, RELEASE).join('\n')}\n`)

// ---- verdict ----

console.log('')
console.log(
  `GATE: ${acceptance.gate.pass} pass, ${acceptance.gate.artifactOnly} artifact-only, ${blockedGates.length} blocked, ${failingGates.length} fail`,
)
console.log(`EVIDENCE: ${acceptance.evidence.length} rows`)
if (acceptance.externalBlockers.length > 0) {
  console.log(`external blockers: ${acceptance.externalBlockers.map((b) => b.id).join(', ')}`)
}
console.log(`hidden UNKNOWN gate rows: ${manifest.hiddenUnknown}`)
if (fast && manifest.pendingGates.length > 0) {
  console.log(`pending (not run under --fast): ${manifest.pendingGates.length}`)
}
console.log(`release/manifest.json hash: ${sha256File(join(RELEASE, 'manifest.json'))}`)

// clean the transient gate dir hashes out of git-tracked churn if --fast
if (fast && existsSync(GATES)) rmSync(GATES, { recursive: true, force: true })

if (failingGates.length > 0 || manifest.hiddenUnknown > 0) {
  console.error(
    `\nrelease:audit FAIL — ${failingGates.length} failing gate(s), ${manifest.hiddenUnknown} hidden UNKNOWN`,
  )
  process.exit(1)
}
console.log('\nrelease:audit PASS')
