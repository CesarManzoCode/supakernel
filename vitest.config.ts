import { defineConfig } from 'vitest/config'

// Runner-neutral scenario harnesses (Bun / Deno / workerd / browser) are launched by their own
// scripts, not by this config (contract §33.1).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'evidence',
          root: import.meta.dirname,
          include: ['test/**/*.test.ts'],
        },
      },
      'packages/contracts',
      'packages/ports',
      'packages/ports-test',
      'packages/schema',
      'packages/policy',
      'packages/data',
      'packages/blob-fs',
      'packages/blob-s3',
      'packages/storage',
      'packages/realtime',
      'packages/management',
      'packages/kernel',
      'packages/gateway',
      'apps/cli',
      'packages/auth',
      'packages/db-postgres',
      'packages/db-pglite',
      'packages/db-sqlite',
    ],
  },
})
