import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/schema',
    include: ['test/**/*.test.ts'],
  },
})
