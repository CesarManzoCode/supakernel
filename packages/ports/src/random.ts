/** Randomness port (contract §6.3, §19.2). All non-determinism flows through here. */
export interface RandomPort {
  /** Cryptographically strong bytes. */
  bytes(length: number): Uint8Array
  /** RFC 4122 v4 UUID from `bytes`. */
  uuidV4(): string
  /** Deterministic stream seeded from a 128-bit hex seed, for scenario replay. */
  seeded(seed: string): RandomPort
}
