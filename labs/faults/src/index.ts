// @supakernel/lab-faults — upgrade fixture + fault-injection / recovery campaign
// (contract §17.2, §22, §30 L12).

export type { FaultCase, FaultCaseResult } from './campaign.js'
export { FAULT_POINTS, runFaultCampaign } from './campaign.js'
export { COUNTING_FAULT, countingFault, oneShotFault } from './fault-port.js'
export { fileJournal } from './journal-file.js'
export {
  fixtureManifest,
  UPGRADE_FIXTURE_EVENTS,
  UPGRADE_FIXTURE_NOTES,
  UPGRADE_FIXTURE_OBJECT,
  UPGRADE_FIXTURE_POLICIES,
  UPGRADE_FIXTURE_SCHEMA,
  UPGRADE_FIXTURE_USERS,
} from './upgrade-fixture.js'
export {
  buildSource,
  buildTarget,
  type SupabaseTarget,
  supabaseTargetFromEnv,
} from './upgrade-harness.js'
