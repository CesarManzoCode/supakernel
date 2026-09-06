import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDatabaseContractSuite } from '@supakernel/ports-test'
import { openNodeSqlite } from '../src/node.ts'

let dir = ''
let file = ''

function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'sk-sqlite-node-'))
  file = join(dir, 'contract.db')
  return file
}

fresh()

runDatabaseContractSuite({
  label: 'node:sqlite (file)',
  open: async () => openNodeSqlite({ path: file }),
  reopen: async () => openNodeSqlite({ path: file }),
  openSecond: async () => openNodeSqlite({ path: file }),
  cleanup: async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    fresh()
  },
})
