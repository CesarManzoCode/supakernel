import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/ports',
    include: ['test/**/*.test.ts'],
  },
})
