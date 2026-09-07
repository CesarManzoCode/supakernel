// @supakernel/lab-conformance — multi-oracle conformance + reference trace lab
// (contract §18, §19, §30 L11). The typechecked surface is target-agnostic and free of any
// client library; the supabase-js wiring lives in the (esbuild-run) test support + runtime
// layer.

export type { RunManifest, WriteArtifactsInput } from './artifact.js'
export {
  redact,
  replayScenarioDir,
  summarizeReports,
  verifyChecksums,
  writeArtifacts,
} from './artifact.js'
export type {
  Classification,
  ClassifyInput,
  DiffClass,
  RegisteredDivergence,
  TargetInfo,
} from './classify.js'
export { BLOCKING_CLASSES, classify } from './classify.js'
export type { CompareInput, DiffEntry } from './compare.js'
export { compare } from './compare.js'
export type { ControlChannel, PortableColumn, PortableTable } from './control.js'
export { createTableSql, portableTableFromStep, runSetupStep } from './control.js'
export type {
  AuthState,
  InterpretSession,
  PublicClient,
  RealtimeState,
  StorageState,
  TargetClient,
} from './interpret.js'
export { interpretStep, newSession } from './interpret.js'
export type { NormalizeContext, NormalizeOptions } from './normalize.js'
export { newContext, normalize } from './normalize.js'
export type { ReduceHooks } from './reduce.js'
export { diffSignature, reduceScenario } from './reduce.js'
export { DIVERGENCE_REGISTRY } from './registry.js'
export type { ReplayResult } from './replay.js'
export { replay } from './replay.js'
export type {
  ClassificationRow,
  NormalizedTargetResult,
  RealtimeDriver,
  RunOptions,
  RunSummary,
  ScenarioReport,
} from './runner.js'
export { runConformance } from './runner.js'
export {
  ALL_SCENARIOS,
  AUTH_SCENARIOS,
  DATA_SCENARIOS,
  MANAGEMENT_SCENARIOS,
  REALTIME_SCENARIOS,
  STORAGE_SCENARIOS,
  scenariosByCapability,
  scenariosForLane,
} from './scenarios.js'
export type {
  Capability,
  CapturedObservation,
  ScenarioValidationIssue,
  StepResult,
  TargetRunResult,
} from './schema.js'
export {
  assertScenario,
  CAPABILITIES,
  OPERATION_ACTIONS,
  pickHeaders,
  RESPONSE_HEADER_ALLOWLIST,
  SETUP_ACTIONS,
  scenarioFingerprint,
  stepInput,
  validateScenario,
} from './schema.js'
export type {
  ExternalArtifactTarget,
  Target,
  TargetGate,
  TargetHealth,
  TargetNature,
  TargetSession,
} from './target.js'
