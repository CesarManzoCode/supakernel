// Common scenario runner (contract §19.2). No branch per target: it drives every Target
// through the same lifecycle and the same shared interpreter.

import type { Json, ScenarioSpec, ScenarioStep } from '@supakernel/contracts'
import { canonicalJson, sha256Hex } from '@supakernel/contracts'
import {
  type Classification,
  classify,
  type DiffClass,
  type RegisteredDivergence,
} from './classify.js'
import { compare, type DiffEntry } from './compare.js'
import { runSetupStep } from './control.js'
import { type InterpretSession, interpretStep, newSession } from './interpret.js'
import { newContext, normalize } from './normalize.js'
import type { CapturedObservation, StepResult, TargetRunResult } from './schema.js'
import { stepInput } from './schema.js'
import type { Target } from './target.js'

export interface RealtimeDriver {
  /** Subscribe on the public client, buffering events into the interpret session. */
  subscribe(
    session: InterpretSession,
    client: import('./interpret.js').TargetClient,
    step: ScenarioStep,
    seatKey: string,
  ): Promise<StepResult>
  mutate(control: import('./control.js').ControlChannel, step: ScenarioStep): Promise<StepResult>
  collect(session: InterpretSession, step: ScenarioStep): Promise<StepResult>
}

async function runScenarioOnTarget(
  target: Target,
  scenario: ScenarioSpec,
  realtime: RealtimeDriver,
): Promise<TargetRunResult> {
  let session: Awaited<ReturnType<Target['open']>>
  try {
    session = await target.open(scenario)
  } catch (err) {
    return {
      target: target.id,
      steps: [],
      observations: [],
      targetFailure: err instanceof Error ? err.message : String(err),
    }
  }
  const interp: InterpretSession = newSession()
  const steps: StepResult[] = []
  try {
    for (const step of scenario.setup) {
      await runSetupStep(session.control, step)
    }
    for (const step of scenario.operations) {
      const seatKey = String(stepInput(step).seat ?? 'anon')
      if (step.action === 'realtime.subscribe') {
        steps.push(await realtime.subscribe(interp, session.client, step, seatKey))
      } else if (step.action === 'realtime.mutate') {
        steps.push(await realtime.mutate(session.control, step))
      } else if (step.action === 'realtime.collect') {
        steps.push(await realtime.collect(interp, step))
      } else {
        steps.push(await interpretStep(session.client, step, seatKey, interp))
      }
    }
    const observations: CapturedObservation[] = []
    for (const spec of scenario.observe) {
      const value = await session.control.capture(spec.of, spec.selector)
      observations.push({ id: spec.id, of: spec.of, value })
    }
    return { target: target.id, steps, observations }
  } catch (err) {
    return {
      target: target.id,
      steps,
      observations: [],
      targetFailure: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await session.dispose().catch(() => undefined)
  }
}

export interface NormalizedTargetResult {
  readonly target: string
  readonly normalized: Json
  readonly targetFailure?: string
  readonly rawHash: string
  readonly normalizedHash: string
}

function normalizeRun(scenario: ScenarioSpec, run: TargetRunResult): NormalizedTargetResult {
  const ctx = newContext()
  const raw: Json = {
    steps: run.steps as unknown as Json,
    observations: run.observations as unknown as Json,
  }
  const normalized = normalize(raw, { normalizers: scenario.normalization, ctx })
  return {
    target: run.target,
    normalized,
    ...(run.targetFailure ? { targetFailure: run.targetFailure } : {}),
    rawHash: sha256Hex(canonicalJson(raw)),
    normalizedHash: sha256Hex(canonicalJson(normalized)),
  }
}

export interface ClassificationRow {
  readonly target: string
  readonly classification: Classification
}

export interface ScenarioReport {
  readonly scenario: string
  readonly capability: string
  readonly oracle: string
  readonly results: readonly NormalizedTargetResult[]
  readonly classifications: readonly ClassificationRow[]
  readonly unclassified: number
  readonly blocking: number
}

export interface RunOptions {
  readonly targets: readonly Target[]
  readonly scenarios: readonly ScenarioSpec[]
  readonly registry: readonly RegisteredDivergence[]
  readonly realtime: RealtimeDriver
  /** Preferred oracle target id (supabase-local); falls back to embedded golden. */
  readonly oracleId: string
  /** Golden normalized outputs by scenario id, used when the vendor oracle is unavailable. */
  readonly goldens: Readonly<Record<string, Json>>
  /** A second vendor reference id whose agreement makes a kernel diff a regression. */
  readonly secondaryVendorId?: string
}

export interface RunSummary {
  readonly reports: readonly ScenarioReport[]
  readonly totalUnclassified: number
  readonly totalBlocking: number
  readonly byClass: Readonly<Record<DiffClass, number>>
}

export async function runConformance(opts: RunOptions): Promise<RunSummary> {
  const reports: ScenarioReport[] = []
  const byClass: Record<DiffClass, number> = {
    kernel_regression: 0,
    vendor_divergence: 0,
    supalite_divergence: 0,
    intentional_divergence: 0,
    normalizer_bug: 0,
    environment_failure: 0,
  }

  for (const scenario of opts.scenarios) {
    const applicable = opts.targets.filter((t) => t.capabilities.includes(scenario.capability))
    const healths = await Promise.all(applicable.map((t) => t.health()))
    const live = applicable.filter((_, i) => healths[i]?.ok)

    const runs = new Map<string, NormalizedTargetResult>()
    for (const target of live) {
      const raw = await runScenarioOnTarget(target, scenario, opts.realtime)
      runs.set(target.id, normalizeRun(scenario, raw))
    }
    // Targets that failed health entirely still get an environment_failure record.
    for (let i = 0; i < applicable.length; i++) {
      const t = applicable[i]
      if (t && !healths[i]?.ok && !runs.has(t.id)) {
        runs.set(t.id, {
          target: t.id,
          normalized: null,
          targetFailure: healths[i]?.detail ?? 'unhealthy',
          rawHash: '',
          normalizedHash: '',
        })
      }
    }

    const oracleResult = runs.get(opts.oracleId)
    const oracleNormalized: Json =
      oracleResult && !oracleResult.targetFailure
        ? oracleResult.normalized
        : (opts.goldens[scenario.id] ?? null)
    const oracleName =
      oracleResult && !oracleResult.targetFailure ? opts.oracleId : `golden:${scenario.id}`

    const secondary = opts.secondaryVendorId ? runs.get(opts.secondaryVendorId) : undefined
    const secondaryAgrees =
      secondary !== undefined &&
      secondary.targetFailure === undefined &&
      compare({
        mode: scenario.compare.mode,
        extraVendorFields: scenario.compare.extraVendorFields ?? [],
        baseline: oracleNormalized,
        candidate: secondary.normalized,
      }).length === 0

    const classifications: ClassificationRow[] = []
    let unclassified = 0
    let blocking = 0
    for (const [id, result] of runs) {
      if (id === opts.oracleId && !result.targetFailure) continue
      const target = applicable.find((t) => t.id === id)
      if (!target) continue
      let diffs: readonly DiffEntry[] = []
      if (!result.targetFailure) {
        diffs = compare({
          mode: scenario.compare.mode,
          extraVendorFields: scenario.compare.extraVendorFields ?? [],
          baseline: oracleNormalized,
          candidate: result.normalized,
        })
      }
      const classification = classify({
        scenario: scenario.id,
        target: { id: target.id, nature: target.nature },
        diffs,
        secondaryVendorAgrees: secondaryAgrees,
        ...(result.targetFailure ? { targetFailure: result.targetFailure } : {}),
        registry: opts.registry,
      })
      byClass[classification.class] += 1
      if (classification.blocking) blocking += 1
      // "unclassified" == a real diff that maps to a blocking class on a mandatory target.
      if (classification.class === 'kernel_regression') unclassified += classification.diffs.length
      classifications.push({ target: target.id, classification })
    }

    reports.push({
      scenario: scenario.id,
      capability: scenario.capability,
      oracle: oracleName,
      results: [...runs.values()],
      classifications,
      unclassified,
      blocking,
    })
  }

  return {
    reports,
    totalUnclassified: reports.reduce((a, r) => a + r.unclassified, 0),
    totalBlocking: reports.reduce((a, r) => a + r.blocking, 0),
    byClass,
  }
}
