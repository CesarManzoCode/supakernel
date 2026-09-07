import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/lab-conformance',
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
