import type { RuntimeId, RuntimeLimits } from '@supakernel/contracts'

export interface ServeOptions {
  readonly hostname: string
  readonly port: number
  /** Non-loopback binding requires this to be explicitly true (contract §25). */
  readonly allowPublic: boolean
}

export interface ServerHandle extends AsyncDisposable {
  readonly url: string
  close(): Promise<void>
}

export interface RealtimeSession {
  readonly id: string
  readonly projectRef: string
}

/**
 * Host abstraction (contract §8, §10). No singletons: a runtime adapter is passed in by
 * composition. `upgradeWebSocket` is optional because the browser profile has no Realtime
 * listener.
 */
export interface RuntimeAdapter {
  readonly id: RuntimeId
  serve(
    handler: (request: Request) => Promise<Response>,
    options: ServeOptions,
  ): Promise<ServerHandle>
  upgradeWebSocket?: (request: Request, session: RealtimeSession) => Promise<Response>
  env(name: string): string | undefined
  readonly hardLimits: RuntimeLimits
}
