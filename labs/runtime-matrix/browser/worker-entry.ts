/**
 * SupaKernel WebWorker for the Browser runtime profile (contract §10, §30 L10). Runs inside a
 * real dedicated Worker in real Chromium. It composes the kernel + gateway against an in-worker
 * database (PGlite or SQLite-WASM/OPFS) and an OPFS blob store, and exposes `fetch(request)` to
 * the page over `postMessage` — no faked socket, no public HTTP listener, no Realtime, no
 * Management SQL.
 */
import { openOpfsBlob } from '@supakernel/blob-opfs'
import { openPglite } from '@supakernel/db-pglite'
import { openWasmSqlite } from '@supakernel/db-sqlite/wasm'
import type { DatabaseAdapter } from '@supakernel/ports'
import { serveInWorker } from '@supakernel/runtime-browser'
import { composeKernel } from '../src/compose.js'

type Profile = 'pglite' | 'sqlite-wasm'

async function openDb(profile: Profile): Promise<DatabaseAdapter> {
  if (profile === 'pglite') return openPglite({ dataDir: 'opfs-ahp://sk-rtm-browser' })
  return openWasmSqlite({ filename: '/sk-rtm-browser.sqlite3' })
}

self.addEventListener('message', async (event: MessageEvent) => {
  const msg = event.data as { kind?: string; profile?: Profile; coreHash?: string }
  if (msg.kind !== 'sk-boot' || !msg.profile) return
  try {
    const adapter = await openDb(msg.profile)
    const composed = await composeKernel({
      adapter,
      blob: openOpfsBlob({ root: `sk-rtm-blob-${msg.profile}` }),
      runtime: 'browser',
      ...(msg.coreHash ? { coreHash: msg.coreHash } : {}),
    })
    serveInWorker(self as unknown as Parameters<typeof serveInWorker>[0], composed.fetch, {
      publishable: composed.kernel.authService.apiKeys.publishable,
      capabilities: composed.kernel.capabilities(),
    })
  } catch (err) {
    self.postMessage({ kind: 'sk-boot-error', error: (err as Error).message ?? String(err) })
  }
})

self.postMessage({ kind: 'sk-worker-loaded' })
