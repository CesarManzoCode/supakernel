/**
 * Execute the fenced shell transcript in every docs/*.md as a real script (contract §27, §30
 * L9). The quickstart must complete well under the 60s machine budget.
 *
 *   node scripts/docs-test.mts
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { repoRoot } from './lib/evidence.mts'

const run = promisify(execFile)

async function main(): Promise<void> {
  const doc = await readFile(join(repoRoot, 'docs/quickstart.md'), 'utf8')
  const block = /```sh\n([\s\S]*?)```/.exec(doc)?.[1]
  if (!block) {
    process.stderr.write('docs-test: no ```sh block in docs/quickstart.md\n')
    process.exit(1)
  }
  const commands = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  const dir = await mkdtemp(join(tmpdir(), 'sk-docs-'))
  const started = Date.now()
  try {
    for (const cmd of commands) {
      const parts = cmd.split(/\s+/)
      const [bin, ...args] = parts.map((p) => (p.startsWith('./') ? join(repoRoot, p) : p))
      const { stdout } = await run(bin as string, args, { cwd: dir })
      if (args.includes('--json')) JSON.parse(stdout) // must be valid JSON
      if (args.includes('typescript') && !stdout.includes('export interface Database')) {
        throw new Error(`types output missing Database interface for: ${cmd}`)
      }
    }
    await stat(join(dir, 'supakernel/config.ts'))
    await stat(join(dir, 'supakernel/schema/0001_init.sql'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const elapsed = Date.now() - started
  if (elapsed > 60_000) {
    process.stderr.write(`docs-test: quickstart took ${elapsed}ms (> 60s budget)\n`)
    process.exit(1)
  }
  process.stdout.write(`docs-test: quickstart ${commands.length} commands in ${elapsed}ms\n`)
}

await main()
