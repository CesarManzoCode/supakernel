import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/lab-reference-traces',
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
  },
})
