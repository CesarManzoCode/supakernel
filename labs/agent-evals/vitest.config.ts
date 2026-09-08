import { defineProject } from 'vitest/config'
export default defineProject({
  test: { name: '@supakernel/lab-agent-evals', root: import.meta.dirname, include: ['test/**/*.test.ts'], testTimeout: 60_000 },
})
