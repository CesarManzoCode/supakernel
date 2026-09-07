import { defineProject } from 'vitest/config'
export default defineProject({ test: { name: '@supakernel/blob-s3', include: ['test/**/*.test.ts'], testTimeout: 30_000 } })
