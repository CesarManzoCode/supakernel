# regression: storage-js issue #64 (signed URL response shape)

The signed-URL response field is `signedURL` and its value is a path beginning with
`/object/sign/<bucket>/<key>?token=<jwt>` — **no** `/storage/v1` prefix. Older servers
returned the value without the leading path segment, breaking clients that concatenate it
to the storage base URL.

Pinned by:
- `packages/storage/test/signed-url-regression.test.ts` (fixture object is 123 bytes)
- `labs/conformance` scenario `storage.upload-download-list-signed-remove` (oracle: supabase-local)
- `labs/reference-traces/traces/storage-signed-url-path-and-64.yaml`

The Supalite 0.10.0 external divergence for #64/#69 is recorded as `supalite_divergence`
in the conformance artifacts, never counted as a kernel pass.
