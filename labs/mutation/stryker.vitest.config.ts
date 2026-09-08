// Single-project vitest config for the Stryker `mutation:critical` run (contract §21). The
// Stryker vitest runner does not drive a `projects` array reliably, so this config is the
// policy package's own suite — where the critical authorization mutants live and the tests
// import the code under mutation from `../src` directly.
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@supakernel/policy',
    root: new URL('../../packages/policy', import.meta.url).pathname,
    include: ['test/**/*.test.ts'],
  },
})
