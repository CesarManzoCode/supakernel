import type { Principal } from './principal.ts'

export type IpClass = 'loopback' | 'private' | 'public' | 'unknown'

/**
 * Everything a service needs about the caller. `now` comes from the Clock port, never
 * `Date.now()`; `abortSignal` propagates client disconnects and the 30s request budget.
 */
export interface RequestContext {
  readonly requestId: string
  readonly projectRef: string
  readonly principal: Principal
  /** RFC3339 UTC, from the Clock port. */
  readonly now: string
  readonly peer: { readonly ipClass: IpClass }
  readonly abortSignal: AbortSignal
}
