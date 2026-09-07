import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDatabaseContractSuite } from '@supakernel/ports-test'
import { vitestApi } from '@supakernel/ports-test/vitest'
import { openNodeSqlite } from '../src/node.js'

let dir = ''
let file = ''

function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'sk-sqlite-node-'))
  file = join(dir, 'contract.db')
  return file
}

fresh()

runDatabaseContractSuite(vitestApi(), {
  label: 'node:sqlite (file)',
  open: async () => openNodeSqlite({ path: file }),
  reopen: async () => openNodeSqlite({ path: file }),
  openSecond: async () => openNodeSqlite({ path: file }),
  cleanup: async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    fresh()
  },
})
