/**
 * Page-side driver for the Browser runtime profile (contract §10, §30 L10). Runs in the real
 * Chromium page: spawns the SupaKernel WebWorker, boots it for a database profile, then runs
 * the common `@supakernel/fixture-app` scenario through `@supabase/supabase-js` whose transport
 * is the MessageChannel bridge. Exposes `window.__runBrowserProfile(profile)` for the harness.
 */
import { createClient } from '@supabase/supabase-js'
import type { FixtureClient, FixtureReport } from '@supakernel/fixture-app'
import { runFixtureScenario } from '@supakernel/fixture-app'
import { createBrowserClient } from '@supakernel/runtime-browser'

declare global {
  interface Window {
    __runBrowserProfile?: (
      profile: 'pglite' | 'sqlite-wasm',
      coreHash: string,
    ) => Promise<{ report: FixtureReport; capabilities: unknown; error?: string }>
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])

window.__runBrowserProfile = async (profile, coreHash) => {
  console.log(`[page] booting worker for ${profile}`)
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  worker.addEventListener('error', (e) => console.error(`[page] worker error: ${e.message}`))
  const loaded = new Promise<void>((resolve, reject) => {
    const onMsg = (e: MessageEvent): void => {
      if (e.data?.kind === 'sk-worker-loaded') {
        worker.removeEventListener('message', onMsg)
        resolve()
      }
      if (e.data?.kind === 'sk-boot-error') {
        worker.removeEventListener('message', onMsg)
        reject(new Error(e.data.error))
      }
    }
    worker.addEventListener('message', onMsg)
  })
  await withTimeout(loaded, 20_000, `${profile} worker load`)
  console.log(`[page] worker loaded; sending sk-boot`)

  const bridge = createBrowserClient(worker)
  worker.addEventListener('message', (e) => {
    if (e.data?.kind === 'sk-boot-error') console.error(`[page] sk-boot-error: ${e.data.error}`)
  })
  worker.postMessage({ kind: 'sk-boot', profile, coreHash })
  const meta = await withTimeout(bridge.ready(), 60_000, `${profile} kernel boot`)
  console.log(`[page] kernel ready`)
  const publishable = String(meta.publishable ?? 'sb_publishable_local')

  try {
    const report = await withTimeout(
      runFixtureScenario({
        label: `browser (${profile}, OPFS)`,
        newClient: (): FixtureClient =>
          createClient('https://browser.local', publishable, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: bridge.fetch },
          }) as unknown as FixtureClient,
      }),
      60_000,
      `${profile} fixture scenario`,
    )
    console.log(`[page] scenario done: ${report.passed}/${report.total}`)
    return { report, capabilities: meta.capabilities ?? null }
  } catch (err) {
    return {
      report: { label: profile, total: 0, passed: 0, failed: 0, cases: [] },
      capabilities: meta.capabilities ?? null,
      error: (err as Error).message ?? String(err),
    }
  } finally {
    bridge.dispose()
  }
}
