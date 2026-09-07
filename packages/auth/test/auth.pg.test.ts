import { describe } from 'vitest'
import { describeAuth } from './auth.scenarios.js'

if (process.env.SUPAKERNEL_TEST_PG_URL) describeAuth('postgres')
else describe.skip('Auth / GoTrue subset — postgres (no SUPAKERNEL_TEST_PG_URL)', () => {})
