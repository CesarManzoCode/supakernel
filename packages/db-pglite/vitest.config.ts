import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/db-pglite',
    include: ['test/**/*.test.ts'],
  },
})
