/**
 * `pnpm test:consumer` (contract §26, §31, §27, §30 L14). A fresh project outside the repo
 * installs the packed tarballs and smoke-tests the public surface: import `@supakernel/kernel`,
 * boot a kernel over node:sqlite, serve the gateway, do one CRUD round-trip with
 * `@supabase/supabase-js`. Proves the tarballs are self-consistent.
 *
 *   node scripts/pack-all.mts && node scripts/test-consumer.mts
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './lib/evidence.mts'

const root = repoRoot
const PACKS = join(root, 'release', 'packs')
if (!existsSync(PACKS)) {
  console.error('test:consumer: run `pnpm pack:all` first')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(PACKS, 'manifest.json'), 'utf8')) as {
  packed: { name: string; file: string }[]
}

const dir = mkdtempSync(join(tmpdir(), 'sk-consumer-'))
const tgz = (file: string): string => join(root, file)

// A consumer needs the kernel + its transitive @supakernel deps + a supabase-js client.
const skDeps = manifest.packed.filter(
  (p) => p.name.startsWith('@supakernel/') && p.name !== '@supakernel/ports-test',
)
writeFileSync(
  join(dir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'sk-consumer-smoke',
      private: true,
      type: 'module',
      dependencies: {
        ...Object.fromEntries(skDeps.map((p) => [p.name, `file:${tgz(p.file)}`])),
        '@supabase/supabase-js': '2.115.0',
      },
    },
    null,
    2,
  )}\n`,
)

writeFileSync(
  join(dir, 'smoke.mjs'),
  `
import { KernelInstance } from '@supakernel/kernel'
import { createGateway } from '@supakernel/gateway'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { openFsBlob } from '@supakernel/blob-fs'
import { systemClock, webRandom } from '@supakernel/auth'
import { createMemoryMailSink } from '@supakernel/ports'
import { sql } from '@supakernel/contracts'
import { createClient } from '@supabase/supabase-js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const adapter = openNodeSqlite({ path: ':memory:' })
await adapter.execute(sql('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)'))
const kernel = await KernelInstance.create({
  projectRef: 'consumer', serverSecret: 's', runtime: 'node', adapter,
  blob: openFsBlob({ root: mkdtempSync(join(tmpdir(), 'c-')) }),
  schema: { version: 1, tables: [{ name: 'notes', columns: [
    { name: 'id', type: 'text', nullable: false, default: null, generated: false },
    { name: 'body', type: 'text', nullable: false, default: null, generated: false },
  ], primaryKey: ['id'], uniques: [], foreignKeys: [], checks: [], indexes: [] }], sequences: [], policies: [] },
  policies: [],
  ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
  management: { token: 'sk_mgmt_consumer', queryEnabled: false },
})
const app = createGateway({ kernel })
const key = kernel.authService.apiKeys.secret
const client = createClient('http://c', key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (u, i) => app.fetch(new Request(typeof u === 'string' ? u : u.url, i)) },
})
const ins = await client.from('notes').insert({ id: 'n1', body: 'hello' }).select()
if (ins.error) throw new Error('insert: ' + ins.error.message)
const sel = await client.from('notes').select('*')
if (sel.error || sel.data.length !== 1 || sel.data[0].body !== 'hello') throw new Error('select mismatch: ' + JSON.stringify(sel))
await kernel.dispose()
console.log('consumer smoke OK — installed from packed tarballs, kernel booted, CRUD round-tripped')
`,
)

console.log(`consumer project: ${dir}`)
try {
  execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: dir, stdio: 'inherit' })
  execSync('node smoke.mjs', { cwd: dir, stdio: 'inherit' })
  console.log('\ntest:consumer PASS')
} catch (err) {
  console.error('\ntest:consumer FAIL')
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
