/** Time port (contract §6.3): no `Date.now()` in the kernel. */
export interface ClockPort {
  /** RFC3339 UTC. */
  now(): string
  /** Milliseconds since the Unix epoch. */
  epochMillis(): number
  /** Monotonic high-resolution reading for durations; unrelated to wall clock. */
  monotonicMillis(): number
}
