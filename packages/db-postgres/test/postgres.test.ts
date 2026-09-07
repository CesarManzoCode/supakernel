import { randomUUID } from 'node:crypto'
import { runDatabaseContractSuite } from '@supakernel/ports-test'
import { vitestApi } from '@supakernel/ports-test/vitest'
import { describe, it } from 'vitest'
import { openPostgres } from '../src/adapter.js'

const baseUrl = process.env.SUPAKERNEL_TEST_PG_URL

if (!baseUrl) {
  describe.skip('PostgreSQL 18.6 contract (set SUPAKERNEL_TEST_PG_URL)', () => {
    it('skipped', () => undefined)
  })
} else {
  // Each suite run gets its own scratch database so cases are fully isolated.
  const admin = openPostgres({ url: baseUrl, id: 'pg-admin' })
  let dbName = ''
  let url = ''

  const makeDb = async (): Promise<void> => {
    dbName = `sk_ct_${randomUUID().replace(/-/g, '')}`
    await admin.execute({ text: `CREATE DATABASE ${dbName}`, parameters: [] })
    const u = new URL(baseUrl)
    u.pathname = `/${dbName}`
    url = u.toString()
  }
  const dropDb = async (): Promise<void> => {
    if (!dbName) return
    await admin.execute({
      text: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      parameters: [dbName],
    })
    await admin.execute({ text: `DROP DATABASE IF EXISTS ${dbName}`, parameters: [] })
    dbName = ''
  }

  await makeDb()

  runDatabaseContractSuite(vitestApi(), {
    label: 'PostgreSQL 18.6 (postgres.js)',
    open: async () => openPostgres({ url }),
    reopen: async () => openPostgres({ url }),
    openSecond: async () => openPostgres({ url }),
    cleanup: async () => {
      await dropDb()
      await makeDb()
    },
  })
}
