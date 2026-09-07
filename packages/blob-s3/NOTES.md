note: the S3/R2 `BlobAdapter` is built on `@aws-sdk/client-s3@3.1127.0` (contract §33.1). The
package was published 2026-09-04T18:48:11Z — inside the 72h supply-chain age gate at the L0
lock anchor — so `pnpm-workspace.yaml` carries the single exact-version exception
`@aws-sdk/client-s3@3.1127.0` (also registered in `scripts/verify-provenance.mts`
`NORMATIVE_PINS`). Its whole transitive closure (@aws-sdk/*, @smithy/*, tslib) resolves to
versions already older than 72h, so no other exception is required.

Verified against a real MinIO endpoint (`SUPAKERNEL_TEST_S3=1`, path-style addressing) and
reused by the storage suite and the Node/Lambda runtime profiles. R2 works with the same
config (virtual-host style: pass `forcePathStyle: false`).
