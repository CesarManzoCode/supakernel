// Test `FaultPort` implementations (contract §22). In production every point is a no-op
// (`NULL_FAULT_PORT`); here a point can count hits, throw, or hard-exit the process on the
// N-th hit — the campaign uses a real subprocess so the exit is genuine.

import type { FaultName, FaultPort } from '@supakernel/ports'

export interface CountingFault extends FaultPort {
  readonly counts: Readonly<Record<string, number>>
}

export function countingFault(): CountingFault {
  const counts: Record<string, number> = {}
  return {
    counts,
    hit(name: FaultName): Promise<void> {
      counts[name] = (counts[name] ?? 0) + 1
      return Promise.resolve()
    },
  }
}

export const COUNTING_FAULT: CountingFault = countingFault()

export type FaultMode = 'throw' | 'exit' | 'delay-throw' | 'adapter-error'

/** Fire once, on the `nth` hit of exactly `target`. */
export function oneShotFault(target: FaultName, mode: FaultMode = 'throw', nth = 1): FaultPort {
  let seen = 0
  return {
    async hit(name: FaultName): Promise<void> {
      if (name !== target) return
      seen += 1
      if (seen !== nth) return
      switch (mode) {
        case 'exit':
          // real, un-caught process death — no `finally` runs (contract §22)
          process.exit(137)
          break
        case 'delay-throw':
          await new Promise((r) => setTimeout(r, 50))
          throw new Error(`SK_FAULT_INJECTED: ${name} (delayed)`)
        case 'adapter-error':
          throw Object.assign(new Error(`SK_FAULT_ADAPTER: ${name}`), { code: 'SK_DB_INTERNAL' })
        default:
          throw new Error(`SK_FAULT_INJECTED: ${name}`)
      }
    },
  }
}
