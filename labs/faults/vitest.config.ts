import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/lab-faults',
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
})
