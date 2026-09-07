import { describe } from 'vitest'
import { describeStorage } from './storage.scenarios.js'

if (process.env.SUPAKERNEL_TEST_PG_URL) describeStorage('postgres', 'fs')
else describe.skip('Storage — postgres (no SUPAKERNEL_TEST_PG_URL)', () => {})
