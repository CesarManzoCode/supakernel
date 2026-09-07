import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    root: import.meta.dirname,
    testTimeout: 200_000,
    hookTimeout: 200_000,
    fileParallelism: false,
  },
})
