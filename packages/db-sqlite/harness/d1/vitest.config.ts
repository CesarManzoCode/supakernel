import { defineConfig } from 'vitest/config'

// First-party D1 harness: real workerd via `wrangler dev`. Not part of the default vitest
// projects (it spawns a subprocess); run explicitly with `pnpm test:db:workers`.
export default defineConfig({
  test: {
    include: ['d1.contract.test.ts'],
    root: import.meta.dirname,
    testTimeout: 60_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
})
