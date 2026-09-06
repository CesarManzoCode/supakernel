/**
 * A tiny jest-compatible test collector so the shared connection contract suite can run
 * inside a real browser WebWorker with no test framework bundled (contract §30 L2).
 */
import type { TestApi } from '@supakernel/ports-test'

export interface CaseResult {
  name: string
  status: 'pass' | 'fail'
  error?: string
}

interface Registered {
  name: string
  fn: () => Promise<void> | void
  timeout: number
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

function matchesObject(actual: unknown, expected: object): boolean {
  if (typeof actual !== 'object' || actual === null) return false
  for (const [k, v] of Object.entries(expected)) {
    const av = (actual as Record<string, unknown>)[k]
    if (typeof v === 'object' && v !== null) {
      if (!matchesObject(av, v)) return false
    } else if (av !== v) {
      return false
    }
  }
  return true
}

function makeExpect(): TestApi['expect'] {
  return (actual: unknown, message?: string) => {
    const label = message ? `${message}: ` : ''
    const matchers = {
      toBe(expected: unknown): void {
        if (actual !== expected)
          throw new Error(`${label}expected ${str(actual)} to be ${str(expected)}`)
      },
      toEqual(expected: unknown): void {
        if (!deepEqual(actual, expected)) {
          throw new Error(`${label}expected ${str(actual)} to equal ${str(expected)}`)
        }
      },
      toMatchObject(expected: object): void {
        if (!matchesObject(actual, expected)) {
          throw new Error(`${label}expected ${str(actual)} to match ${str(expected)}`)
        }
      },
      toBeDefined(): void {
        if (actual === undefined) throw new Error(`${label}expected value to be defined`)
      },
      toBeNull(): void {
        if (actual !== null) throw new Error(`${label}expected ${str(actual)} to be null`)
      },
      toHaveLength(n: number): void {
        const len = (actual as { length?: number })?.length
        if (len !== n) throw new Error(`${label}expected length ${len} to be ${n}`)
      },
      toBeGreaterThan(n: number): void {
        if (!((actual as number) > n)) throw new Error(`${label}expected ${str(actual)} > ${n}`)
      },
      resolves: {
        async toBeUndefined(): Promise<void> {
          const v = await (actual as Promise<unknown>)
          if (v !== undefined) throw new Error(`${label}expected resolved value to be undefined`)
        },
      },
      rejects: {
        async toThrow(msg?: string | RegExp): Promise<void> {
          try {
            await (actual as Promise<unknown>)
          } catch (err) {
            const m = (err as Error).message
            if (msg instanceof RegExp && !msg.test(m))
              throw new Error(`${label}message ${m} !~ ${msg}`)
            if (typeof msg === 'string' && !m.includes(msg))
              throw new Error(`${label}message ${m} !include ${msg}`)
            return
          }
          throw new Error(`${label}expected promise to reject`)
        },
        async toMatchObject(expected: object): Promise<void> {
          try {
            await (actual as Promise<unknown>)
          } catch (err) {
            if (!matchesObject(err, expected)) {
              throw new Error(`${label}rejection ${str(err)} !match ${str(expected)}`)
            }
            return
          }
          throw new Error(`${label}expected promise to reject`)
        },
        async toBeDefined(): Promise<void> {
          try {
            await (actual as Promise<unknown>)
          } catch {
            return
          }
          throw new Error(`${label}expected promise to reject`)
        },
      },
    }
    return matchers
  }
}

function str(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Uint8Array ? [...val] : val)) ?? String(v)
  } catch {
    return String(v)
  }
}

export function createCollectorApi(): { api: TestApi; run: () => Promise<CaseResult[]> } {
  const cases: Registered[] = []
  const afterEachHooks: Array<() => Promise<void> | void> = []

  const api: TestApi = {
    describe(_name, fn) {
      fn()
    },
    it: ((name: string, a: unknown, b?: unknown): void => {
      const opts = typeof a === 'object' ? (a as { timeout?: number }) : {}
      const fn = (typeof a === 'function' ? a : b) as () => Promise<void> | void
      cases.push({ name, fn, timeout: opts.timeout ?? 30_000 })
    }) as TestApi['it'],
    expect: makeExpect(),
    afterEach(fn) {
      afterEachHooks.push(fn)
    },
  }

  async function run(): Promise<CaseResult[]> {
    const results: CaseResult[] = []
    for (const c of cases) {
      try {
        await withTimeout(Promise.resolve(c.fn()), c.timeout, c.name)
        results.push({ name: c.name, status: 'pass' })
      } catch (err) {
        results.push({ name: c.name, status: 'fail', error: (err as Error).message ?? String(err) })
      }
      for (const hook of afterEachHooks) {
        try {
          await hook()
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    return results
  }

  return { api, run }
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`case "${name}" timed out after ${ms}ms`)), ms),
    ),
  ])
}
