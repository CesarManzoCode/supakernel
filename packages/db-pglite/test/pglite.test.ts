import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDatabaseContractSuite } from '@supakernel/ports-test'
import { openPglite } from '../src/adapter.ts'

let dir = ''

function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'sk-pglite-'))
  return join(dir, 'pgdata')
}

let dataDir = fresh()

runDatabaseContractSuite({
  label: 'PGlite 0.5.8 (on-disk)',
  open: async () => openPglite({ dataDir }),
  reopen: async () => openPglite({ dataDir }),
  // PGlite is single-connection; a "second" handle to the same dir is a distinct process-level
  // lock in practice, so the concurrent-writers case is exercised through db-postgres instead.
  cleanup: async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dataDir = fresh()
  },
})
