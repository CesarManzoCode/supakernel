// The concrete divergence this lab has a real, reproduced evidence bundle for (contract §28,
// §30 L13 DONE — "one evidence bundle from a real divergence"). Sourced from the L11
// conformance lane, which recorded and replayed it three times hash-identical.

import { buildEvidenceBundle, type EvidenceBundle } from './bundle.js'
import { classifyOwnership } from './ownership.js'
import type { Divergence } from './reduce.js'

/**
 * `GET` of a non-existent Storage object: `supabase/storage` (v1.70.3, the digest pinned by
 * Supabase CLI 2.116.0) answers **HTTP 400** with `{ "error": "NoSuchKey" }`; SupaKernel
 * answers **HTTP 404** with a stable not-found body. Recorded by the conformance scenario
 * `storage.upload-download-list-signed-remove` (step 6) against `vendor.supabase-local` and
 * `supakernel.pg` / `supakernel.sqlite`; replayed 3× hash-identical.
 */
export const STORAGE_404_DIVERGENCE: Divergence = {
  id: 'storage-get-missing-object-returns-400',
  expected: {
    system: 'REST semantics / SupaKernel',
    status: 404,
    bodyShape: { error: '<not-found>', code: '<string>' },
  },
  actual: {
    system: 'supabase/storage@v1.70.3',
    status: 400,
    bodyShape: { error: 'NoSuchKey', message: '<string>', statusCode: '<string>' },
  },
  steps: [
    { id: 'create-private-bucket', required: true },
    { id: 'upload-object', required: false },
    { id: 'delete-object', required: false },
    { id: 'get-missing-object', required: true },
  ],
}

export function buildStorageDivergenceBundle(): EvidenceBundle {
  const ownership = classifyOwnership({
    capability: 'storage',
    symbols: [
      'getObject',
      'ObjectStorage.findObject',
      'StorageBackendError',
      'S3Backend.getObject',
    ],
    observedIn: 'supabase-local storage-api (supabase/storage)',
  })
  const reproducer = `#!/bin/sh
# Minimal, SupaKernel-independent reproducer against a fresh Supabase local stack.
set -eu
supabase start
API="http://127.0.0.1:54321"
KEY="$(supabase status -o env | sed -n 's/^SERVICE_ROLE_KEY="\\(.*\\)"/\\1/p')"
# create a private bucket
curl -s -X POST "$API/storage/v1/bucket" -H "apikey: $KEY" -H "authorization: Bearer $KEY" \\
  -H 'content-type: application/json' -d '{"id":"repro","name":"repro","public":false}' >/dev/null
# GET an object that was never uploaded
echo "status + body for GET of a missing object:"
curl -s -o /tmp/body -w '%{http_code}\\n' \\
  "$API/storage/v1/object/authenticated/repro/never-existed.txt" \\
  -H "apikey: $KEY" -H "authorization: Bearer $KEY"
cat /tmp/body; echo
# observed: 400  {"statusCode":"400","error":"NoSuchKey","message":"Object not found"}
# expected (RESTful): 404
`
  return buildEvidenceBundle({
    divergence: STORAGE_404_DIVERGENCE,
    minimalSteps: ['create-private-bucket', 'get-missing-object'],
    capability: 'storage',
    versions: {
      'supabase-cli': '2.116.0',
      'supabase/storage': 'v1.70.3',
      '@supabase/storage-js': '2.115.0',
      supakernel: 'branch feat/sprint-3-conformance-release-proof',
    },
    digests: {
      'storage-api-image':
        'public.ecr.aws/supabase/storage-api:v1.70.3 (digest pinned by Supabase CLI 2.116.0)',
    },
    seed: '00000000000000000000000000000001',
    replayCommand:
      'pnpm conformance:replay -- artifacts/conformance/<run>/scenarios/storage.upload-download-list-signed-remove',
    facts: [
      'GET /storage/v1/object/authenticated/<bucket>/<missing-key> returns HTTP 400 (not 404).',
      'The response body is `{ "statusCode": "400", "error": "NoSuchKey", "message": "Object not found" }`.',
      'The same request against SupaKernel returns HTTP 404 with `{ message, code }`.',
      'Reproduced and replayed 3× hash-identical by the SupaKernel conformance lane (scenario storage.upload-download-list-signed-remove, step 6).',
      'A successful download of an existing object is HTTP 200 in both systems; only the not-found case diverges.',
    ],
    causalHypothesis:
      'storage-api appears to surface the backend `NoSuchKey` error through a code path that maps every `StorageBackendError` to HTTP 400 rather than translating a missing-object error to 404. A client that branches on the HTTP status (rather than parsing the JSON `error` field) treats a missing object as a bad request. This is a hypothesis for maintainer evaluation, not a confirmed defect.',
    sourceSymbols: [
      'src/http/routes/object/getObject.ts',
      'src/storage/backend/s3.ts (S3Backend.getObject / headObject)',
      'src/storage/errors.ts (StorageBackendError -> HTTP status mapping)',
    ],
    impact:
      'Capability: storage read. Severity: low — the JSON body still identifies the condition (`error: "NoSuchKey"`), so a client that inspects the body is unaffected; a client that inspects only the HTTP status misclassifies a missing object as a 4xx client error rather than a not-found. No security or data-integrity impact.',
    securityReview:
      'No secret, token, object byte or tenant identifier is exposed by the divergence or this bundle. The reproducer uses the local development service key only.',
    redactionReview:
      'The bundle carries no canary secrets; the recorded conformance artifacts are redacted (JWTs and `sb_secret_*` scrubbed to `<redacted>`).',
    license: 'Apache-2.0 (supabase/storage) — behavioural observation only, no code copied.',
    ownership,
    reproducer,
  })
}
