// Reference-trace schema (contract §18). Every trace pins a repo SHA, files/symbols, a
// license, its own ≤200-word summary and the scenario IDs it gates. A trace that is only a
// README link with no symbol/behaviour/test fails the audit.

import type { YamlValue } from './yaml.js'

export interface TraceSource {
  readonly repository: string
  readonly commit: string
  readonly language: string
  readonly files: readonly string[]
  readonly symbols: readonly string[]
}

export interface ReferenceTrace {
  readonly id: string
  readonly source: TraceSource
  readonly contract: string
  readonly scenarios: readonly string[]
  readonly implementation: string
  readonly resultArtifact: string
  readonly license: string
  readonly notes: string
  readonly summary: string
}

export interface TraceIssue {
  readonly trace: string
  readonly field: string
  readonly message: string
}

const SHA_RE = /^[0-9a-f]{40}$/
const README_ONLY_RE = /readme|docs?\//i

function asRecord(v: YamlValue | undefined): Record<string, YamlValue> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {}
}
function asStringArray(v: YamlValue | undefined): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

export function coerceTrace(raw: YamlValue): ReferenceTrace {
  const r = asRecord(raw)
  const src = asRecord(r.source)
  return {
    id: String(r.id ?? ''),
    source: {
      repository: String(src.repository ?? ''),
      commit: String(src.commit ?? ''),
      language: String(src.language ?? ''),
      files: asStringArray(src.files),
      symbols: asStringArray(src.symbols),
    },
    contract: String(r.contract ?? ''),
    scenarios: asStringArray(r.scenarios),
    implementation: String(r.implementation ?? ''),
    resultArtifact: String(r.resultArtifact ?? ''),
    license: String(r.license ?? ''),
    notes: String(r.notes ?? ''),
    summary: String(r.summary ?? ''),
  }
}

export interface AuditContext {
  /** Scenario ids that actually exist in the conformance set. */
  readonly knownScenarios: ReadonlySet<string>
}

export function auditTrace(trace: ReferenceTrace, ctx: AuditContext): TraceIssue[] {
  const issues: TraceIssue[] = []
  const push = (field: string, message: string): void => {
    issues.push({ trace: trace.id || '(unnamed)', field, message })
  }

  if (!trace.id) push('id', 'missing trace id')
  if (!trace.source.repository.includes('/'))
    push('source.repository', 'must be an owner/name repo reference')
  if (!SHA_RE.test(trace.source.commit))
    push('source.commit', 'must be a pinned 40-char commit SHA (no floating ref)')
  if (!trace.source.language) push('source.language', 'missing language')
  if (trace.source.files.length === 0) push('source.files', 'must list at least one source file')
  if (trace.source.symbols.length === 0)
    push('source.symbols', 'must name at least one symbol / behaviour')
  if (trace.source.files.every((f) => README_ONLY_RE.test(f))) {
    push(
      'source.files',
      'a README/docs link without a code symbol or test does not gate a behaviour',
    )
  }
  if (!trace.contract) push('contract', 'missing contract capability id')
  if (trace.scenarios.length === 0) push('scenarios', 'must gate at least one scenario id')
  for (const s of trace.scenarios) {
    if (!ctx.knownScenarios.has(s)) push('scenarios', `unknown scenario id: ${s}`)
  }
  if (!trace.implementation.startsWith('packages/')) {
    push('implementation', 'must point at the SupaKernel implementation file')
  }
  if (!trace.license) push('license', 'missing license')
  const words = trace.summary.trim().split(/\s+/).filter(Boolean).length
  if (words === 0) push('summary', 'missing own-words behavioural summary')
  if (words > 200) push('summary', `summary is ${words} words (max 200)`)
  if (
    !/no copied code|behavioral reimplementation|behavioural reimplementation/i.test(trace.notes)
  ) {
    push('notes', 'must state this is a behavioural reimplementation with no copied code')
  }
  return issues
}
