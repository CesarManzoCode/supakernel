/**
 * Regenerate packages/schema/schema.lock.json — the canonical `SchemaIR` plus its
 * deterministic hash — from the source SQL in packages/schema/schema/*.sql
 * (contract §17.1, §30 L3). `pnpm schema:lock && git diff --exit-code` must be clean.
 *
 *   node scripts/schema-lock.mts
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalSchemaJson,
  hashSchema,
  normalizeSchema,
  parsePgSchema,
  validateSchema,
} from '../packages/schema/dist/index.js'
import { repoRoot } from './lib/evidence.mts'

const schemaDir = join(repoRoot, 'packages/schema/schema')
const lockPath = join(repoRoot, 'packages/schema/schema.lock.json')

async function main(): Promise<void> {
  const files = (await readdir(schemaDir)).filter((f) => f.endsWith('.sql')).sort()
  const sql = (await Promise.all(files.map((f) => readFile(join(schemaDir, f), 'utf8')))).join('\n')

  const { schema, warnings } = await parsePgSchema(sql)
  const problems = validateSchema(schema)
  if (problems.length > 0) {
    process.stderr.write(`schema:lock FAILED — invalid schema:\n`)
    for (const p of problems) process.stderr.write(`  - ${p.code} ${p.path}: ${p.message}\n`)
    process.exit(1)
  }

  const normalized = normalizeSchema(schema)
  const lock = {
    schemaVersion: 1 as const,
    generatedFrom: files.map((f) => `packages/schema/schema/${f}`),
    hash: hashSchema(normalized),
    ir: JSON.parse(canonicalSchemaJson(normalized)) as unknown,
  }

  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  process.stdout.write(
    `schema.lock.json: ${normalized.tables.length} tables, ${normalized.sequences.length} sequences, ` +
      `hash ${lock.hash}${warnings.length ? ` (${warnings.length} warnings)` : ''}\n`,
  )
}

await main()
