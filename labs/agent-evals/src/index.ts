// @supakernel/lab-agent-evals — fixed-model A/B agent DX eval harness (contract §24, §30 L13).
// Measures product/docs ergonomics between two releases; never ranks models.

export { runSecurityProbes, SECURITY_PROBES } from './probes.js'
export type { AgentRunInput, AgentRunOutput, ModelProvider } from './providers.js'
export { anthropicProvider, scriptedProvider } from './providers.js'
export type { AbReport, Experiment } from './report.js'
export { buildAbReport, writeAbReport } from './report.js'
export type { SandboxHandle } from './sandbox.js'
export { makeSandbox, validateProjectName } from './sandbox.js'
export type { ScoreOutcome, Scorer, ScorerContext, VariantSummary } from './scorer.js'
export {
  assertScorerUntampered,
  canonicalScore,
  scorerHash,
  summarizeVariant,
} from './scorer.js'
export type { TaskDef, TaskResult } from './tasks.js'
export { TASKS_V1 } from './tasks.js'
