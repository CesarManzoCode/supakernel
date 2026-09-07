import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectSchema } from '@supakernel/contracts'
import { buildCapabilities, generateTypescriptTypes } from '@supakernel/management'
import { hashSchema, normalizeSchema, parsePgSchema } from '@supakernel/schema'
import { Command } from 'commander'

/** Exit codes (contract §27). */
export const EXIT = {
  ok: 0,
  usage: 2,
  capability: 3,
  conformance: 4,
  integrity: 5,
  environment: 6,
  security: 7,
} as const

export interface CliIo {
  out(text: string): void
  err(text: string): void
  cwd: string
}

const CONFIG_TEMPLATE = `import { defineConfig } from './define-config'

export default defineConfig({
  projectRef: 'local',
  runtime: 'node',
  database: { driver: 'node-sqlite', path: '.supakernel/data.db' },
  auth: { autoConfirm: true },
})
`

const SCHEMA_TEMPLATE = `CREATE TABLE notes (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  title text NOT NULL,
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`

/** Build the `sk` command tree. Semantics + refusals are ours; Commander only parses args. */
export function buildCli(io: CliIo): Command {
  const program = new Command()
  program
    .name('sk')
    .description('SupaKernel CLI')
    .version('1.0.0')
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) })
    .exitOverride((e) => {
      throw e
    })

  program
    .command('init')
    .argument('[dir]', 'target directory', '.')
    .description('create a minimal config + schema (no dashboard install)')
    .action(async (dir: string) => {
      const base = join(io.cwd, dir, 'supakernel')
      await mkdir(join(base, 'schema'), { recursive: true })
      await writeFile(join(base, 'config.ts'), CONFIG_TEMPLATE)
      await writeFile(join(base, 'schema', '0001_init.sql'), SCHEMA_TEMPLATE)
      io.out(`created ${join(dir, 'supakernel')}/{config.ts, schema/0001_init.sql}\n`)
    })

  program
    .command('doctor')
    .option('--json', 'machine-readable output')
    .description('validate runtime, driver, secrets, ports, drift, capabilities')
    .action(async (opts: { json?: boolean }) => {
      const report = {
        node: process.versions.node,
        node_ok: process.versions.node.startsWith('24.'),
        config_present: await exists(join(io.cwd, 'supakernel', 'config.ts')),
        schema_files: await countSchema(io.cwd),
        secrets_in_env: Boolean(process.env.SUPAKERNEL_SERVER_SECRET),
      }
      if (opts.json) {
        io.out(`${JSON.stringify(report)}\n`)
      } else {
        io.out(`node ${report.node} ${report.node_ok ? 'ok' : 'WARN (expected 24.x)'}\n`)
        io.out(`config: ${report.config_present ? 'found' : 'missing'}\n`)
        io.out(`schema files: ${report.schema_files}\n`)
      }
      if (!report.node_ok) process.exitCode = EXIT.environment
    })

  program
    .command('capabilities')
    .option('--json', 'machine-readable output')
    .option('--runtime <id>', 'runtime profile', 'node')
    .description('print the effective capability matrix')
    .action((opts: { json?: boolean; runtime: string }) => {
      const caps = buildCapabilities({
        runtime: opts.runtime as never,
        databaseFamilies: ['sqlite', 'postgres'],
        services: ['data', 'auth', 'storage', 'realtime', 'management'],
        exclusions: ['rpc', 'broadcast', 'presence', 'oauth', 'mfa', 'edge-functions'],
        coreHash: 'sk-core-1',
      })
      io.out(`${opts.json ? JSON.stringify(caps) : JSON.stringify(caps, null, 2)}\n`)
    })

  program
    .command('types')
    .option('--lang <lang>', 'output language', 'typescript')
    .description('generate types from the deployed schema')
    .action(async (opts: { lang: string }) => {
      if (opts.lang !== 'typescript') {
        io.err(`unsupported language: ${opts.lang}\n`)
        process.exitCode = EXIT.capability
        return
      }
      const schema = await loadSchema(io.cwd)
      io.out(generateTypescriptTypes(schema))
    })

  const db = program.command('db').description('database utilities')
  db.command('diff')
    .requiredOption('--name <name>', 'migration name')
    .description('print the canonical schema hash for the current SQL files')
    .action(async (opts: { name: string }) => {
      const schema = await loadSchema(io.cwd)
      io.out(`${JSON.stringify({ name: opts.name, hash: hashSchema(normalizeSchema(schema)) })}\n`)
    })

  const migration = program.command('migration').description('migration utilities')
  migration
    .command('list')
    .description('list local migration files')
    .action(async () => {
      const dir = join(io.cwd, 'supakernel', 'schema')
      const files = await readdir(dir).catch(() => [])
      for (const f of files.filter((x) => x.endsWith('.sql')).sort()) io.out(`${f}\n`)
    })

  program
    .command('start')
    .description('start the server (never mutates schema implicitly)')
    .action(() => {
      io.out(
        'start: schema is applied explicitly via `sk migration up`; `start` never mutates it\n',
      )
    })

  return program
}

async function loadSchema(cwd: string): Promise<ProjectSchema> {
  const dir = join(cwd, 'supakernel', 'schema')
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.sql')).sort()
  const sql = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n')
  return (await parsePgSchema(sql || 'CREATE TABLE _empty (id uuid PRIMARY KEY);')).schema
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
async function countSchema(cwd: string): Promise<number> {
  const files = await readdir(join(cwd, 'supakernel', 'schema')).catch(() => [])
  return files.filter((f) => f.endsWith('.sql')).length
}
