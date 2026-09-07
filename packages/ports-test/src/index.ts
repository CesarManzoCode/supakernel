// Runner-neutral exports. Vitest projects import `@supakernel/ports-test/vitest` for `vitestApi`.
export type {
  DatabaseContractCase,
  DatabaseContractHarness,
  TestApi,
} from './database-contract.js'
export { DATABASE_CONTRACT_CASES, runDatabaseContractSuite } from './database-contract.js'
