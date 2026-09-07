/**
 * `labs/runtime-matrix` — the six real runtime profiles (contract §10, §30 L10). It composes
 * the kernel + gateway for each profile, runs the common `@supakernel/fixture-app` scenario on
 * the real runtime and emits a signed-off receipt (runtime version, core hash, pass list).
 */
export {
  type Composed,
  type ComposeOptions,
  composeKernel,
  FIXTURE_CREATE_TABLE,
  FIXTURE_POLICIES,
  FIXTURE_SCHEMA,
} from './compose.js'
export { computeCoreHash } from './core-hash.js'
export {
  ALL_PROFILE_IDS,
  RUNTIME_PROFILES,
  type RuntimeProfile,
  type ServiceName,
} from './manifest.js'
export {
  type BuildReceiptInput,
  buildReceipt,
  type RuntimeReceipt,
  receiptIsGreen,
  writeReceipt,
} from './receipt.js'
export {
  assertProfileReports,
  assertReceiptComplete,
  type ProfileAssertion,
} from './runner.js'
