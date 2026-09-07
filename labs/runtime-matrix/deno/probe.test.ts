import { openFsBlob } from '@supakernel/blob-fs'
import { openPglite } from '@supakernel/db-pglite'
import { runFixtureScenario } from '@supakernel/fixture-app'
import { serveDeno } from '@supakernel/runtime-deno'
import { composeKernel } from '../dist/compose.js'
import { computeCoreHash } from '../dist/core-hash.js'

Deno.test('probe', async () => {
  const composed = await composeKernel({
    adapter: openPglite({ dataDir: 'memory://' }),
    blob: openFsBlob({ root: await Deno.makeTempDir() }),
    runtime: 'deno',
    coreHash: await computeCoreHash(),
  })
  const server = await serveDeno({ fetch: composed.fetch })
  const pub = composed.kernel.authService.apiKeys.publishable
  const rep = await runFixtureScenario({
    label: 'deno probe',
    newClient: () => {
      // placeholder — need supabase-js
      throw new Error('nyi')
    },
  })
  console.log(rep)
  await server.close()
  await composed.dispose()
})
