import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/ports-test',
    include: ['test/**/*.test.ts'],
  },
})
