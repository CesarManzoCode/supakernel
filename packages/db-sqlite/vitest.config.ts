import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/db-sqlite',
    include: ['test/**/*.test.ts'],
  },
})
