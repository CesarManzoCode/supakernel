// Benchmark runner (contract §23). Cold start: subprocess from exec to health + first valid
// CRUD, 50 samples per system, interleaved ABBA. Warm HTTP is measured by the report driver
// with autocannon; here we own the cold-start + the ABBA scheduler + the process lifecycle.

import { type ChildProcess, spawn } from 'node:child_process'

export interface SystemLauncher {
  readonly id: string
  /** argv for `spawn` — a self-contained server script that prints `READY <url>` once its
   *  first CRUD round-trips. */
  readonly command: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
}

export interface ColdStartSample {
  readonly system: string
  readonly ms: number
}

async function bootOnce(
  launcher: SystemLauncher,
): Promise<{ ms: number; url: string; child: ChildProcess }> {
  const started = performance.now()
  const child = spawn(launcher.command[0] as string, launcher.command.slice(1), {
    cwd: launcher.cwd,
    env: { ...process.env, ...launcher.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${launcher.id}: no READY within 30s`))
    }, 30_000)
    child.stdout?.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/READY (\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve({ ms: performance.now() - started, url: m[1] as string, child })
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      if (!buf.includes('READY')) {
        clearTimeout(timer)
        reject(new Error(`${launcher.id}: exited ${code} before READY`))
      }
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      r()
    }, 3000)
    child.on('exit', () => {
      clearTimeout(t)
      r()
    })
  })
}

/** ABBA-interleaved cold-start sampling (contract §23 — "50 muestras por sistema intercaladas
 *  ABBA"). Returns raw samples, never trimmed. */
export async function coldStart(
  a: SystemLauncher,
  b: SystemLauncher,
  samplesPerSystem = 50,
): Promise<ColdStartSample[]> {
  const out: ColdStartSample[] = []
  const pairs = Math.ceil(samplesPerSystem / 2)
  for (let i = 0; i < pairs; i++) {
    // A B B A
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      for (const sys of order) {
        const boot = await bootOnce(sys)
        out.push({ system: sys.id, ms: boot.ms })
        await stop(boot.child)
      }
    }
  }
  return out.filter((_, idx) => {
    // keep exactly `samplesPerSystem` per system
    return (
      out.filter((s, j) => j <= idx && s.system === out[idx]?.system).length <= samplesPerSystem
    )
  })
}

/** A single warm request sequence timing (used for a light p50/p95 signal without autocannon). */
export async function warmSequence(
  url: string,
  paths: readonly string[],
  rounds = 200,
): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    const t = performance.now()
    for (const p of paths) await fetch(`${url}${p}`).then((r) => r.arrayBuffer())
    samples.push(performance.now() - t)
  }
  return samples
}
