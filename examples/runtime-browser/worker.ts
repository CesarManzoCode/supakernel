/**
 * Browser WebWorker runtime profile example (contract §10, §30 L10). Runs inside a dedicated
 * Worker: composes the kernel + gateway against PGlite (or SQLite-WASM) + an OPFS blob store
 * and exposes `fetch(request)` to the page over `postMessage`. No public HTTP listener, no
 * Realtime socket, no Management SQL.
 */
import { systemClock, webRandom } from '@supakernel/auth'
import { openOpfsBlob } from '@supakernel/blob-opfs'
import type { SchemaIR } from '@supakernel/contracts'
import { openPglite } from '@supakernel/db-pglite'
import { createGateway } from '@supakernel/gateway'
import { KernelInstance } from '@supakernel/kernel'
import { createMemoryMailSink } from '@supakernel/ports'
import { BROWSER_LIMITS, serveInWorker, type WebHandler } from '@supakernel/runtime-browser'
import schema from './schema.json' with { type: 'json' }

async function boot(): Promise<WebHandler> {
  const kernel = await KernelInstance.create({
    projectRef: 'local',
    serverSecret: 'browser-example-secret',
    runtime: 'browser',
    adapter: openPglite({ dataDir: 'opfs-ahp://sk-example' }),
    blob: openOpfsBlob({ root: 'sk-example-blob' }),
    schema: schema as SchemaIR,
    ports: { clock: systemClock(), random: webRandom(), mail: createMemoryMailSink() },
    limits: BROWSER_LIMITS,
    services: ['data', 'auth', 'storage'],
    exclusions: ['realtime-socket', 'management-sql', 'public-http-listener', 'smtp'],
  })
  const app = createGateway({ kernel, maxBodyBytes: BROWSER_LIMITS.maxRequestBodyBytes })
  return (request) => app.fetch(request)
}

boot().then((handler) => {
  serveInWorker(self as unknown as Parameters<typeof serveInWorker>[0], handler)
})
