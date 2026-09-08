// Registered divergences (contract §19.2 `intentional_divergence` / `normalizer_bug`). Each
// entry is a reviewed, rationale-bearing exception to an exact diff on the included surface,
// scoped to a specific scenario and diff path so it can never mask an unrelated regression.
// Changing this list requires review ("No cambiar: classifications y normalization allowlist
// without review").

import type { RegisteredDivergence } from './classify.js'

export const DIVERGENCE_REGISTRY: readonly RegisteredDivergence[] = [
  {
    id: 'storage.missing-object-download.status',
    scenario: 'storage.upload-download-list-signed-remove',
    path: '/steps/6',
    kind: 'intentional',
    rationale:
      'supabase/storage returns HTTP 400 with `{ error: "NoSuchKey" }` when the requested object does not exist (a known non-RESTful quirk of storage-api). SupaKernel returns 404 with a stable not-found body, which is the correct semantic and what a client that checks `error !== null` still handles. The object is unreadable after delete in both cases — the byte/metadata contract is unchanged.',
    evidence: [
      'packages/storage/src/service.ts',
      'packages/storage/test/storage.scenarios.ts',
      'labs/reference-traces/traces/storage-signed-url-path-and-64.yaml',
    ],
  },
  {
    id: 'data.constraint-message.redacted-identifier',
    scenario: 'data.unique-violation-error',
    path: '/body/error/message',
    kind: 'intentional',
    rationale:
      'PostgREST forwards the PostgreSQL error message verbatim, which embeds the constraint name, relation and column (e.g. `... unique constraint "notes_owner_title_key"`, `... column "title" of relation "notes" ...`). SupaKernel returns the same PGRST/SQLSTATE code and HTTP status but a message with the schema identifiers removed (contract §25 — no schema/identifier leakage; §11.3 — stable codes). `code`, `status` and `details` shape are unchanged.',
    evidence: [
      'packages/data/src/error-map.ts',
      'packages/data/test/crud-scenarios.ts',
      'labs/reference-traces/traces/postgrest-prefer-count-cardinality.yaml',
    ],
  },
]
