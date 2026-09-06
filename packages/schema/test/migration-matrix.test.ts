import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Family, ProjectSchema } from '@supakernel/contracts'
import { openPglite } from '@supakernel/db-pglite'
import { openPostgres } from '@supakernel/db-postgres'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import type { DatabaseAdapter } from '@supakernel/ports'
import { describe, expect, it } from 'vitest'
import {
  applyMigration,
  hashSchema,
  normalizeSchema,
  parsePgSchema,
  planMigration,
} from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/schema')
const read = (rel: string): string => readFileSync(join(fixtures, rel), 'utf8')
const EMPTY: ProjectSchema = { version: 1, tables: [], sequences: [], policies: [] }
const now = (): string => new Date().toISOString()

interface Target {
  label: string
  family: Family
  open: () => Promise<{ adapter: DatabaseAdapter; dispose: () => Promise<void> }>
}

const pgUrl = process.env.SUPAKERNEL_TEST_PG_URL

const targets: Target[] = [
  {
    label: 'node:sqlite',
    family: 'sqlite',
    open: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-mig-sqlite-'))
      const adapter = openNodeSqlite({ path: join(dir, 'm.db') })
      return {
        adapter,
        dispose: async () => {
          await adapter.close()
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
  {
    label: 'PGlite',
    family: 'postgres',
    open: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sk-mig-pglite-'))
      const adapter = openPglite({ dataDir: join(dir, 'pg') })
      return {
        adapter,
        dispose: async () => {
          await adapter.close()
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
]

if (pgUrl) {
  targets.push({
    label: 'PostgreSQL 18.6',
    family: 'postgres',
    open: async () => {
      const admin = openPostgres({ url: pgUrl, id: 'mig-admin' })
      const name = `sk_mig_${randomUUID().replace(/-/g, '')}`
      await admin.execute({ text: `CREATE DATABASE ${name}`, parameters: [] })
      const u = new URL(pgUrl)
      u.pathname = `/${name}`
      const adapter = openPostgres({ url: u.toString() })
      return {
        adapter,
        dispose: async () => {
          await adapter.close()
          await admin.execute({
            text: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            parameters: [name],
          })
          await admin.execute({ text: `DROP DATABASE IF EXISTS ${name}`, parameters: [] })
          await admin.close()
        },
      }
    },
  })
}

const PORTABLE = [
  'portable/001-note.sql',
  'portable/002-project-task.sql',
  'portable/003-types.sql',
]

for (const target of targets) {
  describe(`migration matrix — ${target.label}`, () => {
    for (const fixture of PORTABLE) {
      it(`${fixture}: apply → introspect converges, and is idempotent`, async () => {
        const { adapter, dispose } = await target.open()
        try {
          const { schema } = await parsePgSchema(read(fixture))
          const plan = planMigration(EMPTY, schema, { family: target.family })
          expect(plan.risk).toBe('safe')

          const first = await applyMigration(adapter, plan, { now: now() })
          expect(first.status).toBe('applied')
          expect(first.schemaHash).toBe(hashSchema(schema))

          const observed = await adapter.introspect()
          expect(observed.unmodeled).toEqual([])
          expect(hashSchema(normalizeSchema(observed)), 'apply → introspect equality').toBe(
            hashSchema(schema),
          )

          // idempotence: re-planning from the observed state yields nothing.
          const rePlan = planMigration(normalizeSchema(observed), schema, { family: target.family })
          expect(rePlan.steps).toEqual([])

          // re-applying the same plan is a no-op.
          const second = await applyMigration(adapter, plan, { now: now() })
          expect(second.status).toBe('noop')
        } finally {
          await dispose()
        }
      })
    }

    it('detects drift when the live schema hash does not match the plan fromHash', async () => {
      const { adapter, dispose } = await target.open()
      try {
        const base = (await parsePgSchema(read('drift/030-base.sql'))).schema
        const evolved = (await parsePgSchema(read('drift/031-target.sql'))).schema
        await applyMigration(adapter, planMigration(EMPTY, base, { family: target.family }), {
          now: now(),
        })
        // A plan whose fromHash is EMPTY but the DB already has `base` -> drift.
        const staleFrom = planMigration(EMPTY, evolved, { family: target.family })
        await expect(applyMigration(adapter, staleFrom, { now: now() })).rejects.toThrow(
          /SK_MIGRATION_DRIFT/,
        )
        // The correct plan (from base) applies cleanly.
        const ok = await applyMigration(
          adapter,
          planMigration(base, evolved, { family: target.family }),
          { now: now() },
        )
        expect(ok.status).toBe('applied')
        expect(hashSchema(normalizeSchema(await adapter.introspect()))).toBe(hashSchema(evolved))
      } finally {
        await dispose()
      }
    })

    it('refuses a destructive migration without an explicit mapping', async () => {
      const { adapter, dispose } = await target.open()
      try {
        const before = (await parsePgSchema(read('shadow-copy/040-before.sql'))).schema
        const after = (await parsePgSchema(read('shadow-copy/041-after.sql'))).schema
        await applyMigration(adapter, planMigration(EMPTY, before, { family: target.family }), {
          now: now(),
        })
        const refused = planMigration(before, after, { family: target.family })
        expect(refused.risk).toBe('destructive-refused')
        await expect(applyMigration(adapter, refused, { now: now() })).rejects.toThrow()
        // data + structure untouched
        expect(hashSchema(normalizeSchema(await adapter.introspect()))).toBe(hashSchema(before))
      } finally {
        await dispose()
      }
    })
  })
}
