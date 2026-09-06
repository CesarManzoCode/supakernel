/**
 * Custom dependency-direction checker for the SupaKernel package graph (contract §6.2, §7).
 * No third-party graph tool: the rules are small and specific.
 *
 *   node scripts/check-boundaries.mts
 *
 * Enforces:
 *  - contracts imports nothing (no workspace deps, no runtime libraries)
 *  - ports imports only contracts
 *  - schema and policy never import each other
 *  - data / auth / storage / realtime / management never import hono or a concrete adapter
 *  - adapter packages (db-, blob-, runtime-) never import a service package
 *  - gateway never imports schema, policy or an adapter (no domain, no SQL)
 *  - labs packages import only published entrypoints, never a deep src path
 *  - no import cycle anywhere in the workspace graph
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

interface Pkg {
  dir: string
  name: string
  deps: Set<string>
  imports: Set<string>
}

const RUNTIME_LIB_ALLOW = new Set(['typescript'])

const violations: string[] = []
function violation(msg: string): void {
  violations.push(msg)
}

async function listWorkspaceDirs(): Promise<string[]> {
  const out: string[] = []
  for (const group of ['packages', 'apps', 'labs']) {
    const base = join(repoRoot, group)
    for (const name of await readdir(base)) out.push(join(base, name))
  }
  return out
}

async function walkTs(dir: string, acc: string[]): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return acc
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) {
      await walkTs(full, acc)
    } else if (/\.m?tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      acc.push(full)
    }
  }
  return acc
}

const IMPORT_RE =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

async function loadPackages(): Promise<Pkg[]> {
  const pkgs: Pkg[] = []
  for (const dir of await listWorkspaceDirs()) {
    let manifest: {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    try {
      manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const deps = new Set<string>([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
    const imports = new Set<string>()
    for (const file of await walkTs(join(dir, 'src'), [])) {
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec: string | undefined = m[1] ?? m[2] ?? m[3]
        if (spec !== undefined && spec.length > 0 && !spec.startsWith('.')) imports.add(spec)
      }
    }
    pkgs.push({ dir, name: manifest.name ?? dir, deps, imports })
  }
  return pkgs
}

function pkgKey(spec: string): string {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0] ?? spec
}

function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith('node:')
}

const SERVICES = new Set([
  '@supakernel/data',
  '@supakernel/auth',
  '@supakernel/storage',
  '@supakernel/realtime',
  '@supakernel/management',
  '@supakernel/kernel',
  '@supakernel/gateway',
])

function check(pkgs: Pkg[]): void {
  const byName = new Map(pkgs.map((p) => [p.name, p]))

  for (const p of pkgs) {
    const wsImports = [...p.imports].filter((s) => s.startsWith('@supakernel/')).map(pkgKey)
    const libImports = [...p.imports].filter(
      (s) => !s.startsWith('@supakernel/') && !isNodeBuiltin(s),
    )
    const short = p.name.replace('@supakernel/', '')

    if (p.name === '@supakernel/contracts') {
      if (wsImports.length > 0)
        violation(`contracts imports workspace packages: ${wsImports.join(', ')}`)
      for (const lib of libImports) {
        if (!RUNTIME_LIB_ALLOW.has(pkgKey(lib))) {
          violation(`contracts imports a runtime library: ${lib}`)
        }
      }
    }

    if (p.name === '@supakernel/ports') {
      for (const w of wsImports) {
        if (w !== '@supakernel/contracts') violation(`ports imports ${w} (only contracts allowed)`)
      }
    }

    if (short === 'schema' && wsImports.includes('@supakernel/policy')) {
      violation('schema imports policy')
    }
    if (short === 'policy' && wsImports.includes('@supakernel/schema')) {
      violation('policy imports schema')
    }

    if (['data', 'auth', 'storage', 'realtime', 'management'].includes(short)) {
      if ([...p.imports].some((s) => pkgKey(s) === 'hono')) violation(`${short} imports hono`)
      for (const w of wsImports) {
        if (/^@supakernel\/(db|blob)-/.test(w)) violation(`${short} imports concrete adapter ${w}`)
      }
    }

    if (/^(db|blob|runtime)-/.test(short)) {
      for (const w of wsImports) {
        if (SERVICES.has(w)) violation(`${short} imports service ${w}`)
      }
    }

    if (short === 'gateway') {
      for (const w of wsImports) {
        if (
          w === '@supakernel/schema' ||
          w === '@supakernel/policy' ||
          /^@supakernel\/(db|blob)-/.test(w)
        ) {
          violation(`gateway imports ${w} (no domain / SQL in gateway)`)
        }
      }
    }

    if (p.dir.includes(`${join(repoRoot, 'labs')}`)) {
      for (const s of p.imports) {
        if (s.startsWith('@supakernel/') && s.split('/').length > 2) {
          violation(`${p.name} imports a deep path ${s} (labs use published entrypoints only)`)
        }
      }
    }

    // package.json deps must cover workspace imports
    for (const w of wsImports) {
      if (!p.deps.has(w) && w !== p.name) {
        violation(`${p.name} imports ${w} but does not declare it as a dependency`)
      }
    }
  }

  // cycle detection over declared workspace deps
  const graph = new Map<string, string[]>()
  for (const p of pkgs) {
    graph.set(
      p.name,
      [...p.deps].filter((d) => byName.has(d)),
    )
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  function dfs(n: string): void {
    color.set(n, GRAY)
    stack.push(n)
    for (const m of graph.get(n) ?? []) {
      const c = color.get(m) ?? WHITE
      if (c === GRAY) {
        violation(`import cycle: ${[...stack.slice(stack.indexOf(m)), m].join(' -> ')}`)
      } else if (c === WHITE) {
        dfs(m)
      }
    }
    stack.pop()
    color.set(n, BLACK)
  }
  for (const n of graph.keys()) if ((color.get(n) ?? WHITE) === WHITE) dfs(n)
}

async function main(): Promise<void> {
  const pkgs = await loadPackages()
  check(pkgs)
  if (violations.length > 0) {
    process.stderr.write(`boundary check FAILED (${violations.length}):\n`)
    for (const v of violations) process.stderr.write(`  - ${v}\n`)
    process.exit(1)
  }
  process.stdout.write(`boundary check PASSED (${pkgs.length} workspace packages, 0 violations)\n`)
}

await main()
