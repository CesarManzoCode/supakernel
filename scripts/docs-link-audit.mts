/**
 * `pnpm docs:links` (contract §26, §31 — "docs links audit"). Every relative Markdown link
 * `[text](path)` in docs/, README.md, CONTRIBUTING.md, SECURITY.md and AGENTS.md must resolve
 * (against the file's directory or the repo root). External http(s) links and `mailto:` are
 * listed, not fetched. Inline code spans (`` `foo.ts` ``) are prose, not links, and are not
 * checked.
 *
 *   node scripts/docs-link-audit.mts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
const targets: string[] = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md']
function collectMd(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectMd(full)
    else if (entry.endsWith('.md')) targets.push(full.replace(`${root}/`, ''))
  }
}
if (existsSync(join(root, 'docs'))) collectMd(join(root, 'docs'))

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
let broken = 0
let external = 0
let checked = 0

for (const rel of targets) {
  const path = join(root, rel)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  // biome-ignore lint/suspicious/noAssignInExpressions: regex-exec loop
  while ((m = LINK_RE.exec(text)) !== null) {
    const raw = (m[1] ?? '').trim()
    const link = raw.split('#')[0]?.trim() ?? ''
    if (!link || link.startsWith('mailto:') || link.startsWith('#')) continue
    if (/^https?:\/\//.test(link)) {
      external += 1
      continue
    }
    checked += 1
    const candidates = [
      link.startsWith('/') ? join(root, link) : resolve(dirname(path), link),
      join(root, link.replace(/^\//, '')),
    ]
    if (!candidates.some((c) => existsSync(c))) {
      broken += 1
      console.log(`  BROKEN  ${rel}: ${link}`)
    }
  }
}

console.log(
  `docs:links — ${targets.length} files scanned, ${checked} relative links checked, ${external} external (not fetched), ${broken} broken`,
)
process.exit(broken > 0 ? 1 : 0)
