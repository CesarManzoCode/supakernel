import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORTABLE_TYPES } from '@supakernel/contracts'
import { sqliteTypeFor } from '@supakernel/db-sqlite'
import { describe, expect, it } from 'vitest'
import { hashSchema, normalizeSchema, parsePgSchema, SQLITE_TYPE } from '../src/index.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('SQLite physical type mapping agrees across packages', () => {
  it('schema/dialects/sqlite.ts SQLITE_TYPE matches @supakernel/db-sqlite', () => {
    for (const t of PORTABLE_TYPES) {
      expect(SQLITE_TYPE[t], t).toBe(sqliteTypeFor(t))
    }
  })

  it('no TEXT-affinity name contains the substring INT (which SQLite reads as INTEGER)', () => {
    for (const [portable, sqlite] of Object.entries(SQLITE_TYPE)) {
      if (portable === 'int64' || portable === 'decimal') {
        expect(sqlite.toUpperCase().includes('INT'), `${portable} -> ${sqlite}`).toBe(false)
      }
    }
  })
})

describe('schema.lock.json', () => {
  it('regeneration is byte-identical (pnpm schema:lock is a no-op on a clean tree)', () => {
    const lockFile = join(repoRoot, 'packages/schema/schema.lock.json')
    const before = readFileSync(lockFile, 'utf8')
    execFileSync('node', ['scripts/schema-lock.mts'], { cwd: repoRoot })
    expect(readFileSync(lockFile, 'utf8')).toBe(before)
  })

  it('records the deterministic hash of the canonical kernel schema', async () => {
    const lock = JSON.parse(
      readFileSync(join(repoRoot, 'packages/schema/schema.lock.json'), 'utf8'),
    ) as { hash: string; ir: unknown }
    const sql = readFileSync(
      join(repoRoot, 'packages/schema/schema/0001-kernel-outbox.sql'),
      'utf8',
    )
    const { schema } = await parsePgSchema(sql)
    expect(lock.hash).toBe(hashSchema(normalizeSchema(schema)))
  })
})
