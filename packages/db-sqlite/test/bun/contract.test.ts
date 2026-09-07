import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDatabaseContractSuite, type TestApi } from '@supakernel/ports-test'
import { openBunSqlite } from '../../src/bun.js'

const bunApi = { describe, it, expect, afterEach } as unknown as TestApi

let dir = ''
let file = ''
function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'sk-sqlite-bun-'))
  file = join(dir, 'contract.db')
  return file
}
fresh()

runDatabaseContractSuite(bunApi, {
  label: 'bun:sqlite (file)',
  open: async () => openBunSqlite({ path: file }),
  reopen: async () => openBunSqlite({ path: file }),
  openSecond: async () => openBunSqlite({ path: file }),
  cleanup: async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    fresh()
  },
})
