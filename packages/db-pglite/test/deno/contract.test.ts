// Deno test entrypoint for the PGlite adapter (contract §30 L2).
// Run: deno test -A --node-modules-dir packages/db-pglite/test/deno

import { expect } from 'jsr:@std/expect@1'
import { afterEach, describe, it } from 'jsr:@std/testing@1/bdd'
// @ts-types="@supakernel/ports-test"
import { runDatabaseContractSuite } from '@supakernel/ports-test'
// @ts-types="../../dist/index.d.ts"
import { openPglite } from '../../dist/index.js'

const denoApi = { describe, it, expect, afterEach } as unknown as Parameters<
  typeof runDatabaseContractSuite
>[0]

let dir = ''
function fresh(): string {
  dir = Deno.makeTempDirSync({ prefix: 'sk-pglite-deno-' })
  return `${dir}/pgdata`
}
let dataDir = fresh()

runDatabaseContractSuite(denoApi, {
  label: 'PGlite 0.5.8 (Deno, on-disk)',
  open: () => Promise.resolve(openPglite({ dataDir })),
  reopen: () => Promise.resolve(openPglite({ dataDir })),
  cleanup: async () => {
    try {
      Deno.removeSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    dataDir = fresh()
    await Promise.resolve()
  },
})
