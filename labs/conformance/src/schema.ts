// Conformance scenario schema and vocabulary (contract §8 ScenarioSpec, §19.2).
//
// A scenario is fully declarative. `setup` runs on a per-target control channel;
// `operations` run through the fixed public `@supabase/supabase-js` client. The runner
// never branches on the target id — every target implements the same `Target` port and
// the same operation vocabulary is interpreted once, in `interpret.ts`.

import type { Json, JsonObject, ScenarioSpec, ScenarioStep } from '@supakernel/contracts'
import { canonicalJson } from '@supakernel/contracts'

export type Capability = 'data' | 'auth' | 'storage' | 'realtime' | 'management'

export const CAPABILITIES: readonly Capability[] = [
  'data',
  'auth',
  'storage',
  'realtime',
  'management',
] as const

/** Setup actions run on the control channel (direct DB / admin), never the public client. */
export const SETUP_ACTIONS = [
  'schema.reset',
  'schema.createTable',
  'schema.deployPolicies',
  'db.seed',
  'auth.adminCreateUser',
  'storage.createBucket',
  'realtime.registerTable',
] as const
export type SetupAction = (typeof SETUP_ACTIONS)[number]

/** Operation actions run through the fixed public client. */
export const OPERATION_ACTIONS = [
  // data / PostgREST subset
  'data.select',
  'data.insert',
  'data.update',
  'data.delete',
  'data.upsert',
  // auth / GoTrue subset
  'auth.signUp',
  'auth.signInWithPassword',
  'auth.getUser',
  'auth.updateUser',
  'auth.refreshSession',
  'auth.signOut',
  // storage subset
  'storage.upload',
  'storage.download',
  'storage.list',
  'storage.remove',
  'storage.move',
  'storage.copy',
  'storage.createSignedUrl',
  'storage.signedUrlGet',
  // realtime subset
  'realtime.subscribe',
  'realtime.mutate',
  'realtime.collect',
  // management subset
  'management.listProjects',
  'management.getApiKeys',
  'management.runQuery',
  'management.capabilities',
] as const
export type OperationAction = (typeof OPERATION_ACTIONS)[number]

const SETUP_SET = new Set<string>(SETUP_ACTIONS)
const OP_SET = new Set<string>(OPERATION_ACTIONS)

export interface ScenarioValidationIssue {
  readonly path: string
  readonly message: string
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateStep(
  step: unknown,
  where: string,
  allowed: Set<string>,
  issues: ScenarioValidationIssue[],
): void {
  if (!isObject(step)) {
    issues.push({ path: where, message: 'step must be an object' })
    return
  }
  if (typeof step.id !== 'string' || step.id.length === 0) {
    issues.push({ path: `${where}.id`, message: 'step id must be a non-empty string' })
  }
  if (typeof step.action !== 'string' || !allowed.has(step.action)) {
    issues.push({
      path: `${where}.action`,
      message: `unknown action ${JSON.stringify(step.action)}`,
    })
  }
  if (!('input' in step)) {
    issues.push({ path: `${where}.input`, message: 'step input is required' })
  }
}

/**
 * Validate a candidate object against the ScenarioSpec contract. Pure, deterministic, no I/O.
 * Returns the list of issues (empty means valid).
 */
export function validateScenario(candidate: unknown): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = []
  if (!isObject(candidate)) return [{ path: '$', message: 'scenario must be an object' }]

  if (candidate.schemaVersion !== 1) {
    issues.push({ path: '$.schemaVersion', message: 'schemaVersion must be 1' })
  }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    issues.push({ path: '$.id', message: 'id must be a non-empty string' })
  }
  if (
    typeof candidate.capability !== 'string' ||
    !CAPABILITIES.includes(candidate.capability as Capability)
  ) {
    issues.push({
      path: '$.capability',
      message: `capability must be one of ${CAPABILITIES.join(', ')}`,
    })
  }
  for (const key of ['requires', 'setup', 'operations', 'observe', 'normalization'] as const) {
    if (!Array.isArray(candidate[key])) {
      issues.push({ path: `$.${key}`, message: `${key} must be an array` })
    }
  }
  if (Array.isArray(candidate.setup)) {
    candidate.setup.forEach((s, i) => {
      validateStep(s, `$.setup[${i}]`, SETUP_SET, issues)
    })
  }
  if (Array.isArray(candidate.operations)) {
    if (candidate.operations.length === 0) {
      issues.push({ path: '$.operations', message: 'a scenario needs at least one operation' })
    }
    candidate.operations.forEach((s, i) => {
      validateStep(s, `$.operations[${i}]`, OP_SET, issues)
    })
  }
  if (!isObject(candidate.compare) || typeof candidate.compare.mode !== 'string') {
    issues.push({ path: '$.compare', message: 'compare.mode is required' })
  }
  if (typeof candidate.seed !== 'string' || !/^[0-9a-f]{32}$/.test(candidate.seed)) {
    issues.push({ path: '$.seed', message: 'seed must be 128-bit lowercase hex (32 chars)' })
  }
  if ('unsupported' in candidate && candidate.unsupported !== undefined) {
    const u = candidate.unsupported
    if (
      !isObject(u) ||
      !Array.isArray(u.targets) ||
      typeof u.code !== 'string' ||
      typeof u.reason !== 'string'
    ) {
      issues.push({
        path: '$.unsupported',
        message: 'unsupported must be { targets: string[], code: string, reason: string }',
      })
    }
  }
  return issues
}

export function assertScenario(candidate: unknown): asserts candidate is ScenarioSpec {
  const issues = validateScenario(candidate)
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join('; ')
    throw new Error(`invalid ScenarioSpec: ${detail}`)
  }
}

/** Canonical hash input for a scenario — the exact bytes every target sees. */
export function scenarioFingerprint(scenario: ScenarioSpec): string {
  return canonicalJson(scenario as unknown as Json)
}

export interface StepResult {
  readonly step: string
  readonly action: string
  /** Logical request as issued (method + path + query + body), target-independent. */
  readonly request: JsonObject
  readonly status: number
  /** Allowlisted response headers only. */
  readonly headers: Record<string, string>
  readonly body: Json
  /** Stable capability-refusal marker when the client surfaced one. */
  readonly unsupported?: { readonly code: string; readonly reason: string }
  readonly error?: string
}

export interface CapturedObservation {
  readonly id: string
  readonly of: string
  readonly value: Json
}

export interface TargetRunResult {
  readonly target: string
  readonly steps: readonly StepResult[]
  readonly observations: readonly CapturedObservation[]
  /** Set when the target itself failed to provision / stay healthy for this scenario. */
  readonly targetFailure?: string
}

export const RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  'content-type',
  'content-range',
  'range',
  'accept-ranges',
  'preference-applied',
  'content-profile',
  'x-total-count',
  'www-authenticate',
  'retry-after',
  'location',
] as const

export function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of RESPONSE_HEADER_ALLOWLIST) {
    const v = headers.get(key)
    if (v !== null) out[key] = v
  }
  return out
}

export function stepInput(step: ScenarioStep): JsonObject {
  return isObject(step.input) ? step.input : {}
}
