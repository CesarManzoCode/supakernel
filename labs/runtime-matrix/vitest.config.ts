import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/lab-runtime-matrix',
    root: import.meta.dirname,
    include: ['node/**/*.test.ts', 'lambda/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
