// @supakernel/lab-benchmarks — honest capability-intersection benchmarks vs BKND
// (contract §23, §30 L13).

export type { Environment, WorkloadOp } from './manifest.js'
export {
  REQUIRED_DURABILITY,
  WORKLOAD_OPS,
  WORKLOAD_SCHEMA,
  WORKLOAD_TABLE,
} from './manifest.js'
export type { BenchReport, MetricSamples } from './report.js'
export { buildReport, captureEnvironment, writeReport } from './report.js'
export type { ColdStartSample, SystemLauncher } from './runner.js'
export { coldStart, warmSequence } from './runner.js'
export type { CI, Summary, Verdict } from './stats.js'
export { bootstrapMedianCI, compareVerdict, summarize } from './stats.js'
export { bkndClient, supakernelClient } from './systems.js'
export type { LogicalResult, SystemClient, ValidationIssue, ValidationReport } from './validator.js'
export { validate } from './validator.js'
