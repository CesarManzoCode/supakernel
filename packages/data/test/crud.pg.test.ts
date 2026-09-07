import { openPostgres } from '@supakernel/db-postgres'
import { describe } from 'vitest'
import { describeCrud } from './crud-scenarios.js'

const URL = process.env.SUPAKERNEL_TEST_PG_URL
if (URL) {
  describeCrud('postgres', () => openPostgres({ url: URL }))
} else {
  describe.skip('Data / PostgREST subset — postgres (no SUPAKERNEL_TEST_PG_URL)', () => {})
}
