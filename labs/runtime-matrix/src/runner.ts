import type { RuntimeId } from '@supakernel/contracts'
import type { FixtureReport } from '@supakernel/fixture-app'
import { RUNTIME_PROFILES } from './manifest.js'
import type { RuntimeReceipt } from './receipt.js'

export interface ProfileAssertion {
  readonly ok: boolean
  readonly failures: readonly string[]
}

/** Check a set of fixture reports against a profile's contract (contract §30 L10). */
export function assertProfileReports(
  runtime: RuntimeId,
  reports: readonly FixtureReport[],
): ProfileAssertion {
  const profile = RUNTIME_PROFILES[runtime]
  const failures: string[] = []
  if (reports.length === 0) failures.push(`${runtime}: no fixture report produced`)
  for (const report of reports) {
    if (report.total === 0) failures.push(`${report.label}: scenario ran zero cases`)
    for (const c of report.cases) {
      if (!c.ok) failures.push(`${report.label} › ${c.name}: ${c.error ?? 'failed'}`)
    }
  }
  // Every profile must run the whole common Data/Auth/Storage scenario.
  const MIN_CASES = 13
  for (const report of reports) {
    if (report.total < MIN_CASES) {
      failures.push(`${report.label}: only ${report.total} cases (< ${MIN_CASES})`)
    }
  }
  void profile
  return { ok: failures.length === 0, failures }
}

export function assertReceiptComplete(receipt: RuntimeReceipt): ProfileAssertion {
  const profile = RUNTIME_PROFILES[receipt.runtime]
  const failures: string[] = []
  if (!receipt.coreHash.startsWith('sha256:')) failures.push('missing core hash')
  if (!receipt.runtimeVersion) failures.push('missing runtime version')
  if (receipt.passList.length === 0) failures.push('empty pass list')
  if (receipt.passList.some((p) => !p.ok)) failures.push('pass list has a failing case')
  if (receipt.extraChecks.some((c) => !c.ok)) {
    failures.push(
      `failing extra check: ${receipt.extraChecks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(', ')}`,
    )
  }
  if (!receipt.bundleAudit.ok)
    failures.push(`bundle audit found: ${receipt.bundleAudit.forbidden.join(', ')}`)
  const caps = receipt.capabilityEndpoint as {
    services?: Record<string, unknown>
    core_hash?: string
  } | null
  if (!caps || typeof caps !== 'object') failures.push('missing capability endpoint document')
  else {
    if (caps.core_hash !== receipt.coreHash) {
      failures.push(
        `capability endpoint core_hash (${caps.core_hash}) != receipt (${receipt.coreHash})`,
      )
    }
    for (const svc of profile.services) {
      if (profile.managementReadOnly && svc === 'management') continue
      if (!caps.services?.[svc]) failures.push(`capability endpoint does not advertise ${svc}`)
    }
  }
  return { ok: failures.length === 0, failures }
}

export { RUNTIME_PROFILES } from './manifest.js'
