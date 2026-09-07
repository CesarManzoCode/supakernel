import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/realtime',
    include: ['test/**/*.test.ts'],
    exclude: ['test/bun/**', 'test/deno/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
