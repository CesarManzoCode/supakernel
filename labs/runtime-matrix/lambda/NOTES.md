# AWS Lambda (Node 24 container) — real L10 acceptance gate

`pnpm test:runtime:lambda` builds the locked OCI image and executes it. It is **not** an
in-process simulation: `container-entry.ts` is esbuild-bundled to `index.mjs`, baked into an
image `FROM public.ecr.aws/lambda/nodejs:24@sha256:2472f027…` (the linux/amd64 manifest, also
recorded in `examples/runtime-lambda/image-lock.json`), and run under the **AWS Lambda Runtime
Interface Emulator**. Every fixture case and profile check goes through the real API Gateway
HTTP API v2 invocation endpoint (`POST /2015-03-31/functions/function/invocations`).

## Prerequisites on the host

- **Postgres 18.6** reachable (`SUPAKERNEL_TEST_PG_URL`) and an **S3-compatible store**
  (`SUPAKERNEL_TEST_S3=1`, default MinIO at `127.0.0.1:59000`, bucket `skrtm`).
- A **rootless container engine**. This host uses statically-linked **podman 6.1.1**
  (`mgoltzsche/podman-static`) installed under `~/.local` — no root, no system policy change:
  - binaries in `~/.local/bin` (podman, crun, runc, fuse-overlayfs, pasta), helpers in
    `~/.local/lib/podman`, config in `~/.config/containers/` (overlay + fuse-overlayfs,
    `cgroup_manager = cgroupfs`, `netns = host`).
  - `/etc/subuid` + `/etc/subgid` already grant the user a range; `newuidmap`/`newgidmap`
    carry file capabilities; unprivileged user namespaces are enabled.
  - pasta cannot open `/dev/net/tun` here, so containers run with `--network=host`; the
    container reaches host Postgres/MinIO on `127.0.0.1` and the emulator binds a free host
    port via `--runtime-interface-emulator-address`.
- The **Lambda RIE** binary at `~/.local/lib/aws-lambda-rie/aws-lambda-rie`
  (`aws/aws-lambda-runtime-interface-emulator` v1.37), bind-mounted into the container.

Overrides: `SUPAKERNEL_CONTAINER_ENGINE`, `SUPAKERNEL_LAMBDA_RIE`.

If no container engine is found the test **skips with the precise blocker** — it never emits a
fake receipt, and Sprint 2 must not be called complete in that state.

## What the receipt proves

Node 24 inside the image · `AWS_LAMBDA_RUNTIME_API` / `LAMBDA_TASK_ROOT=/var/task` /
`AWS_EXECUTION_ENV=AWS_Lambda_nodejs24.x` set by the RIC · the 13-case Data/Auth/Storage/health
fixture over PG 18.6 + S3 · published Lambda limits/exclusions · Realtime WebSocket refused
(426) · a second, genuinely fresh container (distinct pid + boot nonce) serving the same
provisioned database with an identical core hash.
