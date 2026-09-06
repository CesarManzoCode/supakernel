import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/db-pglite',
    include: ['test/**/*.test.ts'],
    exclude: ['test/bun/**', 'test/deno/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
