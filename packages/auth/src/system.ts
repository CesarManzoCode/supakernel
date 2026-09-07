import type { ClockPort, RandomPort } from '@supakernel/ports'

/** A `ClockPort` backed by the host clock — an adapter, so the kernel still never calls `Date` directly. */
export function systemClock(): ClockPort {
  return {
    now: () => new Date().toISOString(),
    epochMillis: () => Date.now(),
    monotonicMillis: () => performance.now(),
  }
}

/** A `RandomPort` backed by WebCrypto CSPRNG. */
export function webRandom(): RandomPort {
  const self: RandomPort = {
    bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
    uuidV4: () => crypto.randomUUID(),
    seeded: () => self,
  }
  return self
}

/** A deterministic `RandomPort` for tests / scenario replay (xorshift, seeded). */
export function seededRandom(seedHex: string): RandomPort {
  let s = BigInt(`0x${(seedHex || '1').replace(/[^0-9a-f]/gi, '').slice(0, 16) || '1'}`) || 1n
  const next = (): number => {
    s ^= s << 13n
    s ^= s >> 7n
    s ^= s << 17n
    s &= (1n << 64n) - 1n
    return Number(s & 0xffffffffn) / 0x100000000
  }
  const self: RandomPort = {
    bytes: (length: number) => {
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) out[i] = Math.floor(next() * 256)
      return out
    },
    uuidV4: () => {
      const b = self.bytes(16)
      b[6] = ((b[6] as number) & 0x0f) | 0x40
      b[8] = ((b[8] as number) & 0x3f) | 0x80
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    },
    seeded: (seed: string) => seededRandom(seed),
  }
  return self
}
