// Registered divergences (contract §19.2 `intentional_divergence` / `normalizer_bug`). Each
// entry is a reviewed, rationale-bearing exception to an exact diff on the included surface.
// Changing this list requires review (contract "No cambiar: classifications y normalization
// allowlist without review").

import type { RegisteredDivergence } from './classify.js'

export const DIVERGENCE_REGISTRY: readonly RegisteredDivergence[] = [
  {
    id: 'auth.error-shape.gotrue-legacy-fields',
    scenario: 'auth.wrong-password-error',
    path: '/error',
    kind: 'intentional',
    rationale:
      'GoTrue returns both a legacy `error`/`error_description` pair and the newer `code`/`error_code`. SupaKernel emits the canonical `{ message, code }` shape only (contract §12.1). supabase-js normalizes both to an AuthError, so the client-visible behaviour matches; the raw legacy alias fields are intentionally absent.',
    evidence: ['packages/auth/src/errors.ts', 'packages/auth/test/security.test.ts'],
  },
  {
    id: 'data.error.pgrst-hint-detail',
    scenario: 'data.unique-violation-error',
    path: '/steps',
    kind: 'intentional',
    rationale:
      'PostgREST forwards Postgres `hint`/`detail` verbatim. SupaKernel maps the SQLSTATE to a stable code and a redacted message (contract §11.3, §25 — no schema/identifier leakage), so `hint`/`detail` are intentionally dropped and the constraint name is a semantic marker.',
    evidence: ['packages/data/src/error-map.ts', 'packages/data/test/crud-scenarios.ts'],
  },
  {
    id: 'data.single.pgrst116-body',
    scenario: 'data.single-cardinality-error',
    path: '/steps',
    kind: 'intentional',
    rationale:
      'On `.single()` with zero/many rows PostgREST returns PGRST116 with `details` describing the row count. SupaKernel returns the same code and status with a stable message and no row-count leak (contract §11.3).',
    evidence: ['packages/data/src/result.ts', 'packages/data/test/crud-scenarios.ts'],
  },
]
