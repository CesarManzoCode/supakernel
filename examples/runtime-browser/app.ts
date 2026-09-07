/**
 * Page-side example for the Browser runtime profile (contract §10, §30 L10). Spawns the
 * SupaKernel WebWorker and talks to it with a normal `@supabase/supabase-js` client whose
 * transport is the MessageChannel bridge.
 */
import { createClient } from '@supabase/supabase-js'
import { createBrowserClient } from '@supakernel/runtime-browser'

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
const bridge = createBrowserClient(worker)
await bridge.ready()

const supabase = createClient('https://browser.local', 'sb_publishable_local', {
  auth: { persistSession: false },
  global: { fetch: bridge.fetch },
})

const { data, error } = await supabase.auth.signUp({
  email: 'demo@example.com',
  password: 'password-example-123',
})
console.log('signed up in the browser worker', { data, error })
