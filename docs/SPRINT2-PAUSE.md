# Sprint 2 pause state

Provisional continuation document. Written at an explicit user pause request.

## Repository
- **branch:** `feat/sprint-2-services-runtime`
- **current local HEAD:** `8226de2a45fcb82badbdd67d68d6902ed839720a`
- **current remote HEAD:** `8226de2a45fcb82badbdd67d68d6902ed839720a` (origin/feat/sprint-2-services-runtime)
- **local HEAD == remote HEAD:** YES
- **timestamp:** 2026-09-07T04:44Z
- **working tree state:** CLEAN (`git status --porcelain` empty). Nothing staged, nothing modified, nothing untracked that matters (`labs/runtime-matrix/receipts/` is gitignored and regenerated on demand).

## Original remaining task
Three concrete contract corrections against `feat/sprint-2-services-runtime`, preserving all
existing green behaviour. NOT reopening Sprint 2 generally, NOT auditing unrelated code, NOT
starting Sprint 3, NO PR, NO merge.

1. Every effective tsconfig must have `skipLibCheck:false` (the offender was
   `scripts/tsconfig.json` which set `skipLibCheck:true`).
2. `packages/blob-s3` must use exactly `@aws-sdk/client-s3@3.1127.0` (it had a hand-written
   S3 REST + SigV4 client as the production path).
3. L10 Lambda must execute through a REAL Node 24 container runtime, not an in-process
   `composeKernel()` + simulated API Gateway v2 path.

## Current progress

### Item 1 — strict TypeScript for scripts — **DONE (verified)**
Commit `e933780` "fix(l9): restore strict TypeScript checks for scripts".

- `scripts/tsconfig.json`: `skipLibCheck` flipped `true → false`.
- Root cause of the original workaround: `@redocly/openapi-core@1.34.19` (transitive of the
  pinned `openapi-typescript@7.13.0`) ships `.d.ts` files
  (`lib/config/types.d.ts`, `lib/types/redocly-yaml.d.ts`) that
  `import type { JSONSchema } from 'json-schema-to-ts'` — a package it never declares.
- Clean fix: added the genuinely-missing types package as an exact devDependency in the root
  `package.json`: `json-schema-to-ts@3.1.1` (this is exactly the version @redocly's own
  devDeps use — `^3.1.0`). Published 2024-08-29, far outside the 72h supply-chain age gate —
  no age-gate exception needed. pnpm hoists it into `node_modules/.pnpm/node_modules/` so the
  @redocly `.d.ts` resolves it.
- No files excluded, no strictness weakened, no ambient `any`, nothing moved to another
  tsconfig. Every effective tsconfig either sets `skipLibCheck:false` explicitly
  (`tsconfig.base.json`, `scripts/tsconfig.json`) or inherits it from `tsconfig.base.json`
  (verified: no non-base tsconfig `extends` anything else).
- `pnpm-lock.yaml`, `vendor-lock/packages.json`, `THIRD_PARTY_NOTICES.md` regenerated
  (`pnpm lock:vendors` with `GH_TOKEN`).
- Verified: `pnpm typecheck` PASS (incl. `tsc -p scripts/tsconfig.json --noEmit` with a
  forced `--incremental false` clean run), `pnpm generate` PASS + deterministic,
  `pnpm verify:provenance` PASS, `pnpm lint` PASS.
- Remaining: nothing.

### Item 2 — pinned AWS SDK S3 client — **DONE (verified)**
Commit `9e397ab` "fix(l7): use the pinned @aws-sdk/client-s3 for the S3/R2 blob adapter".

- `packages/blob-s3/package.json`: added `"@aws-sdk/client-s3": "3.1127.0"` to
  `dependencies` (exact, no caret/range). Description string updated.
- `packages/blob-s3/src/index.ts`: rewritten to use `S3Client` +
  `PutObjectCommand` / `CopyObjectCommand` / `GetObjectCommand` / `HeadObjectCommand` /
  `DeleteObjectCommand` / `ListObjectsV2Command`. Request signing / retry / streaming is now
  the SDK's. `S3Config` type kept in `index.ts`. `openS3Blob(cfg)` / `S3BlobAdapter` exports
  unchanged. `forcePathStyle` default = path-style (`cfg.forcePathStyle !== false`), so MinIO
  works out of the box and R2 virtual-host works with `forcePathStyle: false`.
- `packages/blob-s3/src/sigv4.ts`: **deleted** (the custom SigV4/WebCrypto client). Only a
  small local WebCrypto `sha256Hex` remains for the contract's hash/size enforcement in
  `putStaged` — that is a semantic requirement, not signing.
- Semantics preserved: staged writes under `staging/<opId>`, server-side-copy `promote` +
  staged delete (idempotent-replay tolerant), inclusive range reads, `stat` (→ null on 404),
  `delete`, paginated `listStaged` (ContinuationToken loop), SHA-256 + size enforcement,
  S3-compatible endpoints, MinIO, R2, `forcePathStyle`.
- `packages/blob-s3/NOTES.md`: rewritten to record the SDK choice + the age-gate exception.
- Supply chain: `@aws-sdk/client-s3@3.1127.0` published 2026-09-04T18:48:11Z — inside the 72h
  gate at the L0 lock anchor. Its **entire transitive closure resolves to versions already
  older than 72h** (verified with a registry walk — only the top package is fresh), so:
  - `pnpm-workspace.yaml` `minimumReleaseAgeExclude` gains the single exact-version entry
    `@aws-sdk/client-s3@3.1127.0` (with a comment explaining the closure).
  - `scripts/verify-provenance.mts` `NORMATIVE_PINS` gains `@aws-sdk/client-s3@3.1127.0`.
  - `pnpm install` (unfrozen) succeeded — pnpm's supply-chain policy check re-runs against
    *current* time on every install and only flagged the one excluded package.
- `pnpm-lock.yaml` (+~300 lines, 28 pkgs), `vendor-lock/packages.json`,
  `THIRD_PARTY_NOTICES.md` regenerated.
- Tests executed (env below):
  - `pnpm test:storage:s3` → 7 files / 48 tests PASS (real MinIO, `SUPAKERNEL_TEST_S3=1`)
  - `pnpm vitest run --project @supakernel/blob-s3 --reporter verbose` → 4/4 PASS against
    real MinIO (round-trip 46ms, range reads exact)
  - `pnpm test:blob:fs` → 5/5 PASS
  - `pnpm test:storage` → 6 files / 44 PASS
  - `pnpm test:runtime:node` (exercises S3 blob) → PASS
- Remaining: nothing.

### Item 3 — real Lambda Node 24 container — **DONE (verified)**
Commits `f0c1e3f` "fix(l10): execute the Lambda profile in a real Node 24 container" and
`8226de2` "fix(l10): poll the restarted Lambda container's health check".

- **A real rootless container runtime was installed under `~/.local` — no root, no system
  policy change.** See "Environment state".
- New files under `labs/runtime-matrix/lambda/`:
  - `container-entry.ts` — the Lambda handler that runs *inside* the image. Composes the
    kernel through the shared `../src/compose.js#composeKernel` (same core, same core hash as
    every other profile) over Postgres + an S3-compatible store; reads config from env; one
    warm handler. Adds `/_harness/keys` (publishable API key) and `/_harness/runtime`
    (`process.version`, `AWS_LAMBDA_RUNTIME_API`, `LAMBDA_TASK_ROOT`, `AWS_EXECUTION_ENV`,
    `pid`, a per-process `bootNonce`). Honours `SUPAKERNEL_RESTART=true` → `restart: true`.
  - `Dockerfile` — `FROM public.ecr.aws/lambda/nodejs:24@sha256:2472f027…` (the **linux/amd64
    manifest** digest, cross-checked at build time against
    `examples/runtime-lambda/image-lock.json`). `COPY index.mjs ${LAMBDA_TASK_ROOT}/`,
    `CMD ["index.handler"]`. The bundle is esbuild-produced and NOT committed.
  - `container.ts` — `resolveContainerEngine()` (podman/docker on PATH, `~/.local/bin`, or
    `$SUPAKERNEL_CONTAINER_ENGINE`), `resolveRie()` (`$SUPAKERNEL_LAMBDA_RIE`,
    `~/.local/lib/aws-lambda-rie/aws-lambda-rie`, PATH), `verifyBaseImagePin()`,
    `buildContainerBundle()` (esbuild, platform node, esm, node24, CJS-interop banner),
    `buildImage()` (`podman build --platform linux/amd64`), `class LambdaContainer`
    (`--network=host`, RIE at a free port via `--runtime-interface-emulator-address`, invoke
    over `POST /2015-03-31/functions/function/invocations`, `poll()` helper, `logs()`,
    `stop()`).
  - `NOTES.md` — full host prerequisites + what the receipt proves.
  - `run-lambda-profile.ts` — **rewritten**: builds + runs the real image, drives the 13-case
    Data/Auth/Storage/health fixture and every profile check through the emulator, then starts
    a **second, genuinely fresh container** (distinct `bootNonce`) with `SUPAKERNEL_RESTART`
    against the same provisioned DB and polls `/_system/health`. If no container engine is
    found it raises `LambdaContainerUnavailable` (the single sanctioned blocker).
  - `lambda.runtime.test.ts` — **rewritten**: `resolveLambdaPrereqs()` at module load; if
    the blocker fires the test `ctx.skip(...)`s loudly with the precise reason (never a fake
    receipt); otherwise runs the real gate (600s timeout).
  - `client.ts` — unchanged (its `lambdaFixtureClient(baseUrl, key, handler)` already takes a
    `LambdaHandler`; `LambdaContainer#invoke` matches that shape).
- `examples/runtime-lambda/image-lock.json` + `examples/runtime-lambda/Dockerfile`: the AWS
  multi-arch **index** tag was rebuilt (old index digest `a63325…` was GC'd from
  public.ecr.aws), refreshed to the current index digest `ba8267…`. The **per-platform
  manifest digests are unchanged** (`linux/amd64: 2472f027…`, `linux/arm64: 104527dd…`).
- Receipt now records (real values, seen this session): `node v24.20.0`,
  `AWS_LAMBDA_RUNTIME_API=127.0.0.1:9001`, `LAMBDA_TASK_ROOT=/var/task`,
  `AWS_EXECUTION_ENV=AWS_Lambda_nodejs24.x`, 13/13 fixture cases over real PG 18.6 + MinIO,
  Lambda limits/exclusions published, Realtime WebSocket refused (426), a fresh container
  (distinct boot nonce) serving with an identical core hash.
- Tests executed:
  - `pnpm test:runtime:lambda` → PASS, run **4 times** standalone (once initially failing on
    an over-6 MiB payload assertion — fixed by asserting on an oversized `Content-Length`
    header instead, since a real >6 MiB payload is refused by the Lambda platform itself and
    crashes the warm RIC).
  - `pnpm test` (full suite) → **359/359 PASS**, run **twice consecutively** clean. One
    earlier full-suite run flaked on the restarted-container health check under peak load →
    fixed in `8226de2` (poll `/_system/health` 20×1s, drop the unreliable cross-PID-namespace
    pid comparison, keep the boot nonce).
- Remaining: nothing functional. (Optional hardening ideas, not required: pin the container
  Postgres pool size; add the amd64 manifest digest to a machine-checked provenance file.)

## Current exact failure / blocker
**None.** All three items complete and verified.

One transient, non-blocking observation during the final sweep:
`pnpm verify:provenance` exited 1 **once** — `scripts/verify-provenance.mts` calls
`npmPublishTime()` which does a live `fetch` to `registry.npmjs.org`; an occasional network
timeout there fails the run. It **passed immediately on re-run** and passed many times earlier
this session. Not a code issue. If it recurs tomorrow: just re-run it.

## Next exact action
The three fixes are done, committed and pushed. If a fresh session wants to re-confirm before
declaring Sprint 2 closed:

1. `source ~/.local/bin/sk-env.sh`
2. Ensure PG + MinIO are up (see "Environment state"); export the env vars listed there.
3. Run `corepack pnpm install --frozen-lockfile` then, in order:
   `pnpm verify:provenance` · `pnpm check:boundaries` · `pnpm typecheck` · `pnpm lint` ·
   `pnpm generate && git diff --exit-code`

Then the next actions:

4. `pnpm test:storage && pnpm test:storage:s3 && pnpm test:blob:fs`
5. `pnpm test:runtime:lambda`  (needs `XDG_RUNTIME_DIR` + `~/.local/bin` on PATH for podman)
6. `pnpm test`  (full suite, 359 tests; the lambda container gate is included)
7. If all green, produce the Sprint 2 final report. Do NOT open a PR, do NOT merge, do NOT
   start Sprint 3.

## Environment state
- **Container runtime: AVAILABLE.** Rootless **podman 6.1.1** (statically linked,
  `mgoltzsche/podman-static` v6.1.1) installed entirely under `~/.local`:
  - binaries: `~/.local/bin/{podman,crun,runc,fuse-overlayfs,fusermount3,passt,pasta,pasta.avx2}`
  - helpers: `~/.local/lib/podman/{conmon,netavark,aardvark-dns,rootlessport,catatonit}`,
    `~/.local/libexec/podman/quadlet`
  - config: `~/.config/containers/{containers.conf,storage.conf,registries.conf,policy.json,seccomp.json}`
    — overlay + `mount_program=fuse-overlayfs`, `ignore_chown_errors=true`,
    `cgroup_manager=cgroupfs`, `netns=host`, `network_backend=netavark`,
    graphroot `~/.local/share/containers/storage`.
  - Host facts that make it work: `/etc/subuid` + `/etc/subgid` grant
    `cesarmanzocode:100000:65536`; `newuidmap`/`newgidmap` carry file caps
    (`cap_setuid=ep` / `cap_setgid=ep`); `/proc/sys/kernel/unprivileged_userns_clone=1`;
    `/dev/fuse` present; `nsenter`, `iptables`, `nft` present.
  - **pasta cannot open `/dev/net/tun`** on this host → containers run `--network=host`
    (works; container reaches host PG/MinIO on `127.0.0.1`). RIE listens on a free host port
    via `--runtime-interface-emulator-address 127.0.0.1:<port>`.
  - Base image already pulled into local storage: `public.ecr.aws/lambda/nodejs:24`
    (index `ba8267…`, amd64 manifest `2472f027…`, ~438 MB).
- **AWS Lambda RIE: AVAILABLE** at `~/.local/lib/aws-lambda-rie/aws-lambda-rie`
  (`aws/aws-lambda-runtime-interface-emulator` v1.37, static Go, x86_64). Supports
  `--runtime-interface-emulator-address host:port`.
- **PostgreSQL 18.6**: userland cluster, data dir `~/.local/pgdata`, listening
  `127.0.0.1:55432`, user `postgres`, trust auth. Was already running this session (PID seen
  ~32872). Restart if needed:
  `$PGBIN/pg_ctl -D ~/.local/pgdata -o "-p 55432 -k $HOME/.local/pgrun -c listen_addresses='127.0.0.1' -c fsync=off" -w start`
  (`$PGBIN` comes from `sk-env.sh`; there is no `psql`/`pg_isready` on PATH — use a node client or `ss -ltn`).
- **MinIO**: `~/.local/minio/minio server /tmp/minio-data --address 127.0.0.1:59000
  --console-address 127.0.0.1:59001`, was already running (PID ~149134). Buckets `skblob`
  and `skrtm` exist under `/tmp/minio-data/`. Root creds are the usual dev pair (see var
  names below, values not recorded).
- **Env vars required to rerun the affected gates** (names only):
  - `SUPAKERNEL_TEST_PG_URL` = `postgres://postgres@127.0.0.1:55432/postgres`
  - `SUPAKERNEL_TEST_S3=1`
  - `SUPAKERNEL_TEST_S3_ENDPOINT` = `http://127.0.0.1:59000` (optional; this is the default)
  - `SUPAKERNEL_TEST_S3_KEY` / `SUPAKERNEL_TEST_S3_SECRET` (optional; default to the dev MinIO pair)
  - `XDG_RUNTIME_DIR` = `/run/user/1000` (needed so the vitest process can drive rootless podman)
  - PATH must include `~/.local/bin` (podman); `source ~/.local/bin/sk-env.sh` also does this.
  - Optional overrides: `SUPAKERNEL_CONTAINER_ENGINE`, `SUPAKERNEL_LAMBDA_RIE`.
- **New tooling/deps installed this session**: `json-schema-to-ts@3.1.1` (root devDep),
  `@aws-sdk/client-s3@3.1127.0` + closure (blob-s3 dep), rootless podman + RIE (userland only,
  not in the repo).

## Validation state (after the latest relevant changes = HEAD 8226de2)
- frozen install .......... PASS
- verify:provenance ....... PASS (one transient network flake, re-ran green — see above)
- check:boundaries ........ PASS (34 packages, 0 violations)
- typecheck .............. PASS
- lint .................... PASS (0 errors, 19 pre-existing warnings)
- generate + git diff ..... PASS (deterministic, tree clean)
- test:storage ............ PASS (44)
- test:storage:s3 ......... PASS (48, real MinIO)
- blob tests (blob:fs) .... PASS (5); blob-s3 via storage:s3 PASS (4)
- runtime:lambda .......... PASS (real container; run 4× standalone)
- full `pnpm test` ........ PASS (359/359; run 2× consecutively clean)

## Git recovery
```
git status                                          -> clean (nothing to commit, working tree clean)
git rev-parse HEAD                                   -> 8226de2a45fcb82badbdd67d68d6902ed839720a
git rev-parse origin/feat/sprint-2-services-runtime  -> 8226de2a45fcb82badbdd67d68d6902ed839720a
```
local HEAD == remote HEAD: **YES** (before this pause document is committed).

Commits added this session, oldest first:
- `e933780` fix(l9): restore strict TypeScript checks for scripts
- `9e397ab` fix(l7): use the pinned @aws-sdk/client-s3 for the S3/R2 blob adapter
- `f0c1e3f` fix(l10): execute the Lambda profile in a real Node 24 container
- `8226de2` fix(l10): poll the restarted Lambda container's health check
- (+ this `docs/SPRINT2-PAUSE.md` checkpoint commit)

## Sprint 2 status
All three cited contract violations are resolved and verified. Sprint 2 can be reported as
closed after an optional re-run of the validation list above. No PR, no merge, no Sprint 3.
