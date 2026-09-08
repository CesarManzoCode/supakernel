import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/lab-mutation',
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
