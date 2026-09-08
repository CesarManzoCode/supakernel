// Capability-intersection validator (contract §23.1). Before any timing, prove the two
// systems return the same status class, the same logical result and the same post-state for
// the fixed workload — and that they run with the same durability settings.

import { REQUIRED_DURABILITY, type WorkloadOp } from './manifest.js'

export interface LogicalResult {
  /** 2xx / 4xx / 5xx bucket. */
  readonly statusClass: string
  /** Ordered row identities (by `id`) the op returned, or null for a non-list op. */
  readonly rowIds: readonly number[] | null
  /** Total count when the op reports one. */
  readonly count: number | null
  /** For get/insert/update: the canonical row `{tenant_id, body, done}` (id-independent). */
  readonly row: { tenant_id: string; body: string; done: boolean } | null
}

/** Every system adapter maps one workload op onto its own REST shape and normalizes back. */
export interface SystemClient {
  readonly id: string
  run(op: WorkloadOp): Promise<LogicalResult>
  /** The effective SQLite durability settings, read from the live DB. */
  durability(): Promise<{ journalMode: string; foreignKeys: boolean; synchronous: string }>
  /** Count rows in the workload table (post-state check). */
  rowCount(): Promise<number>
}

export interface ValidationIssue {
  readonly op: string
  readonly field: string
  readonly a: unknown
  readonly b: unknown
}

function normSync(v: string): string {
  const m: Record<string, string> = { '0': 'OFF', '1': 'NORMAL', '2': 'FULL', '3': 'EXTRA' }
  return (m[v] ?? v).toUpperCase()
}

function eqResult(x: LogicalResult, y: LogicalResult): ValidationIssue[] {
  const out: ValidationIssue[] = []
  if (x.statusClass !== y.statusClass)
    out.push({ op: '', field: 'statusClass', a: x.statusClass, b: y.statusClass })
  if (JSON.stringify(x.rowIds) !== JSON.stringify(y.rowIds))
    out.push({ op: '', field: 'rowIds', a: x.rowIds, b: y.rowIds })
  if (x.count !== y.count) out.push({ op: '', field: 'count', a: x.count, b: y.count })
  if (JSON.stringify(x.row) !== JSON.stringify(y.row))
    out.push({ op: '', field: 'row', a: x.row, b: y.row })
  return out
}

export interface ValidationReport {
  readonly ok: boolean
  readonly durabilityOk: boolean
  readonly issues: readonly ValidationIssue[]
  readonly durability: Record<string, unknown>
}

export async function validate(
  a: SystemClient,
  b: SystemClient,
  ops: readonly WorkloadOp[],
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = []
  const [da, db] = await Promise.all([a.durability(), b.durability()])
  const durabilityOk =
    da.journalMode.toUpperCase() === REQUIRED_DURABILITY.journalMode &&
    db.journalMode.toUpperCase() === REQUIRED_DURABILITY.journalMode &&
    da.foreignKeys === REQUIRED_DURABILITY.foreignKeys &&
    db.foreignKeys === REQUIRED_DURABILITY.foreignKeys &&
    normSync(da.synchronous) === normSync(db.synchronous)

  for (const op of ops) {
    const [ra, rb] = await Promise.all([a.run(op), b.run(op)])
    for (const issue of eqResult(ra, rb)) issues.push({ ...issue, op: op.id })
  }
  const [ca, cb] = await Promise.all([a.rowCount(), b.rowCount()])
  if (ca !== cb) issues.push({ op: 'post-state', field: 'rowCount', a: ca, b: cb })

  return {
    ok: issues.length === 0 && durabilityOk,
    durabilityOk,
    issues,
    durability: { [a.id]: da, [b.id]: db },
  }
}
