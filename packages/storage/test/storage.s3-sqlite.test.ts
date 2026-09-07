import { describe } from 'vitest'
import { describeStorage } from './storage.scenarios.js'

if (process.env.SUPAKERNEL_TEST_S3 === '1') describeStorage('sqlite', 's3')
else describe.skip('Storage — sqlite + s3 blob (set SUPAKERNEL_TEST_S3=1)', () => {})
