import { defineProject } from 'vitest/config'
export default defineProject({
  test: { name: '@supakernel/blob-fs', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
})
