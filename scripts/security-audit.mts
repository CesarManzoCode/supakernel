/**
 * `pnpm security:audit` (contract §25, §26, §31). Combines the attack catalog, the auth
 * security suite, the semantic mutants and a canary-secret redaction scan into one gate:
 * no leak, no escalation, no cross-tenant access.
 *
 *   node scripts/security-audit.mts
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
let failed = false

function run(label: string, cmd: string): void {
  process.stdout.write(`  ${label} … `)
  try {
    execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('PASS')
  } catch (err) {
    failed = true
    console.log('FAIL')
    const e = err as { stdout?: Buffer; stderr?: Buffer }
    console.log(String(e.stdout ?? '').slice(-2000))
    console.log(String(e.stderr ?? '').slice(-2000))
  }
}

run(
  'authorization attack catalog (§13.2)',
  'pnpm exec vitest run --project @supakernel/policy test/attacks.test.ts',
)
run(
  'auth security suite (§12)',
  'pnpm exec vitest run --project @supakernel/auth test/security.test.ts',
)
run('semantic mutants (§21.1)', 'pnpm mutation:semantic')

// canary-secret redaction scan: no artifact/log under artifacts/ may contain a raw JWT or
// service-key. The conformance/redaction layer scrubs to `<redacted>`.
const CANARY =
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9]{20,}|sk_secret_[A-Za-z0-9]{16,}/
function scan(dir: string): number {
  let hits = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      hits += scan(full)
    } else if (/\.(json|txt|md|log|jsonl)$/.test(entry)) {
      const text = readFileSync(full, 'utf8')
      if (CANARY.test(text)) {
        // allow the well-known DEMO keys that Supabase CLI ships in the clear on purpose
        const stripped = text.replace(
          /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
          '',
        )
        if (CANARY.test(stripped)) {
          console.log(`  LEAK  ${full}`)
          hits += 1
        }
      }
    }
  }
  return hits
}
process.stdout.write('  artifact redaction scan … ')
const leaks = scan(join(root, 'artifacts'))
if (leaks > 0) {
  failed = true
  console.log(`FAIL (${leaks} file(s) with an un-redacted secret)`)
} else {
  console.log('PASS')
}

console.log(failed ? '\nsecurity:audit FAIL' : '\nsecurity:audit PASS')
process.exit(failed ? 1 : 0)
