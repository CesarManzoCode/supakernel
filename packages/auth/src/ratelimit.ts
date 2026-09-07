import type { ClockPort } from '@supakernel/ports'

/**
 * Token-bucket rate limiter keyed by IP-class + an HMAC of the email (contract §12.2). The
 * clock is injected so tests are deterministic. In-process; a distributed deployment swaps the
 * store, not the algorithm.
 */
export interface RateLimitRule {
  readonly capacity: number
  readonly refillPerSecond: number
}

interface Bucket {
  tokens: number
  updatedMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly clock: ClockPort
  private readonly rules: Readonly<Record<string, RateLimitRule>>
  constructor(clock: ClockPort, rules: Readonly<Record<string, RateLimitRule>>) {
    this.clock = clock
    this.rules = rules
  }

  /** Returns `true` when the action is allowed and consumes a token. */
  take(action: string, key: string): boolean {
    const rule = this.rules[action]
    if (!rule) return true
    const id = `${action}:${key}`
    const nowMs = this.clock.epochMillis()
    const b = this.buckets.get(id) ?? { tokens: rule.capacity, updatedMs: nowMs }
    const refill = ((nowMs - b.updatedMs) / 1000) * rule.refillPerSecond
    b.tokens = Math.min(rule.capacity, b.tokens + refill)
    b.updatedMs = nowMs
    if (b.tokens < 1) {
      this.buckets.set(id, b)
      return false
    }
    b.tokens -= 1
    this.buckets.set(id, b)
    return true
  }
}

export const DEFAULT_RATE_LIMITS: Readonly<Record<string, RateLimitRule>> = {
  'token:password': { capacity: 30, refillPerSecond: 30 / 300 },
  signup: { capacity: 30, refillPerSecond: 30 / 3600 },
  recover: { capacity: 5, refillPerSecond: 5 / 3600 },
  verify: { capacity: 30, refillPerSecond: 30 / 300 },
}
