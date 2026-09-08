// Opt-in / external conformance targets (contract §19.1). None run by default:
//  - vendor.supabase-hosted : a pre-authorized project, release-only, owner credentials
//  - blackbox.supalite      : the public `supalite` npm package (EVIDENCE lane; its
//                             divergences are recorded, never counted as a kernel pass/fail)
//  - external.supadiff      : an external CLI whose JSON artifacts are imported, never its
//                             internals; skipped when not installed
// Kept in test-support (not `src/`) for the same reason as the other client-touching wiring:
// `@supabase/supabase-js` types do not satisfy `exactOptionalPropertyTypes`.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { Json } from '@supakernel/contracts'
import type {
  ControlChannel,
  Target,
  TargetClient,
  TargetHealth,
  TargetSession,
} from '../../src/index.js'

const NOOP_CONTROL: ControlChannel = {
  family: 'postgres',
  async reset() {},
  async createTable() {
    throw new Error('opt-in target is provisioned out of band')
  },
  async deployPolicies(_p: Json) {},
  async seed() {},
  async adminCreateUser() {},
  async createBucket() {},
  async registerRealtimeTable() {},
  async capture() {
    return null
  },
}

/** `vendor.supabase-hosted` — never a PR default; needs SUPAKERNEL_CONF_HOSTED=1 + creds. */
export function createSupabaseHostedTarget(): Target {
  const optedIn = process.env.SUPAKERNEL_CONF_HOSTED === '1'
  const url = process.env.SUPAKERNEL_CONF_HOSTED_URL
  const serviceKey = process.env.SUPAKERNEL_CONF_HOSTED_SERVICE_KEY
  const anonKey = process.env.SUPAKERNEL_CONF_HOSTED_ANON_KEY
  return {
    id: 'vendor.supabase-hosted',
    nature: 'vendor',
    gate: 'opt-in',
    capabilities: ['data', 'auth', 'storage', 'realtime'],
    async health(): Promise<TargetHealth> {
      if (!optedIn) return { ok: false, detail: 'hosted lane not opted in (release-only, §32)' }
      if (!url || !serviceKey || !anonKey) {
        return {
          ok: false,
          detail: 'SUPAKERNEL_CONF_HOSTED_URL / *_SERVICE_KEY / *_ANON_KEY missing',
        }
      }
      try {
        const r = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey } })
        return r.ok
          ? { ok: true, detail: 'hosted reachable' }
          : { ok: false, detail: `hosted ${r.status}` }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },
    async open(): Promise<TargetSession> {
      if (!optedIn || !url || !serviceKey || !anonKey) throw new Error('hosted lane unavailable')
      const client: TargetClient = {
        baseUrl: url,
        client: (seat) =>
          createClient(url, seat === 'service' ? serviceKey : anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          }) as unknown as ReturnType<TargetClient['client']>,
        fetch: (path, init) => fetch(`${url}${path}`, init),
        managementToken: () => serviceKey,
      }
      return { control: NOOP_CONTROL, client, async dispose() {} }
    },
  }
}

/** `blackbox.supalite` — the public npm package, run against a Postgres URL it is given. */
export function createSupaliteTarget(): Target {
  const enabled = process.env.SUPAKERNEL_CONF_SUPALITE === '1'
  return {
    id: 'blackbox.supalite',
    nature: 'blackbox',
    gate: 'opt-in',
    capabilities: ['data', 'auth', 'storage'],
    async health(): Promise<TargetHealth> {
      if (!enabled)
        return { ok: false, detail: 'supalite lane disabled (set SUPAKERNEL_CONF_SUPALITE=1)' }
      try {
        // vendored install: labs/conformance/vendor/supalite (kept out of the main lockfile)
        const mod = await import(
          /* @vite-ignore */ `${process.cwd()}/labs/conformance/vendor/supalite/dist/index.js`
        )
        return mod
          ? { ok: true, detail: 'supalite vendored' }
          : { ok: false, detail: 'supalite import empty' }
      } catch (err) {
        return {
          ok: false,
          detail: `supalite not vendored: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
    async open(): Promise<TargetSession> {
      throw new Error(
        'supalite adapter: vendor supalite@0.10.0 under labs/conformance/vendor/supalite and point it at SUPAKERNEL_CONF_SUPALITE_DB_URL',
      )
    },
  }
}

/** `external.supadiff` — imports pre-computed JSON artifacts only. */
export interface SupadiffLane {
  readonly id: 'external.supadiff'
  available(): boolean
  importObservation(scenarioId: string): Json | null
}
export function createSupadiffLane(): SupadiffLane {
  const dir = process.env.SUPAKERNEL_CONF_SUPADIFF_DIR ?? ''
  return {
    id: 'external.supadiff',
    available() {
      if (dir && existsSync(dir)) return true
      try {
        execFileSync('supadiff', ['--version'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    importObservation(scenarioId) {
      const path = `${dir}/${scenarioId}.json`
      return dir && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Json) : null
    },
  }
}
