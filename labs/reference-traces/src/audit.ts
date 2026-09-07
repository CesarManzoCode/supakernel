// `trace:audit` (contract §18, §30 L11). Loads every trace under traces/, validates it
// against the schema, and checks the four gate chains (PostgREST, GoTrue, Storage incl. #64,
// Realtime) are each covered by at least one trace.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_SCENARIOS } from '@supakernel/lab-conformance'
import {
  type AuditContext,
  auditTrace,
  coerceTrace,
  type ReferenceTrace,
  type TraceIssue,
} from './schema.js'
import { parseYaml } from './yaml.js'

const TRACES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'traces')

const GATE_CHAINS: readonly { name: string; repo: string }[] = [
  { name: 'PostgREST/Haskell', repo: 'PostgREST/postgrest' },
  { name: 'GoTrue/Go', repo: 'supabase/auth' },
  { name: 'Storage/TypeScript', repo: 'supabase/storage' },
  { name: 'Realtime/Elixir', repo: 'supabase/realtime' },
]

export function loadTraces(dir: string = TRACES_DIR): ReferenceTrace[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => coerceTrace(parseYaml(readFileSync(join(dir, f), 'utf8'))))
}

export interface AuditReport {
  readonly traces: number
  readonly issues: readonly TraceIssue[]
  readonly missingChains: readonly string[]
  readonly ok: boolean
}

export function auditAll(dir: string = TRACES_DIR): AuditReport {
  const traces = loadTraces(dir)
  const ctx: AuditContext = { knownScenarios: new Set(ALL_SCENARIOS.map((s) => s.id)) }
  const issues: TraceIssue[] = []
  for (const trace of traces) issues.push(...auditTrace(trace, ctx))

  const missingChains = GATE_CHAINS.filter(
    (chain) => !traces.some((t) => t.source.repository === chain.repo),
  ).map((c) => c.name)

  // #64 must be explicitly covered.
  if (!traces.some((t) => /issue-64|#64|issue_64/i.test(`${t.id} ${t.notes} ${t.summary}`))) {
    issues.push({
      trace: '(chain)',
      field: 'storage',
      message: 'no trace covers storage-js issue #64',
    })
  }

  return {
    traces: traces.length,
    issues,
    missingChains,
    ok: issues.length === 0 && missingChains.length === 0,
  }
}

export function formatReport(report: AuditReport): string {
  const lines = [`reference traces: ${report.traces}`]
  if (report.missingChains.length > 0)
    lines.push(`MISSING GATE CHAINS: ${report.missingChains.join(', ')}`)
  for (const issue of report.issues)
    lines.push(`  ✗ ${issue.trace} [${issue.field}] ${issue.message}`)
  lines.push(report.ok ? 'trace:audit PASS' : 'trace:audit FAIL')
  return lines.join('\n')
}
