import { afterEach, describe, expect, it } from 'vitest'
import type { TestApi } from './database-contract.js'

/** The `TestApi` backed by Vitest, for `runDatabaseContractSuite` inside a Vitest project. */
export function vitestApi(): TestApi {
  return { describe, it, expect, afterEach } as unknown as TestApi
}
