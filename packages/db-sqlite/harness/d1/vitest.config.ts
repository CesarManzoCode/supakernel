import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    root: import.meta.dirname,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
