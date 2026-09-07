# Real AWS Lambda (Node 24) container image for the L10 runtime-matrix acceptance gate
# (contract §10, §30 L10). Same base as examples/runtime-lambda/Dockerfile; the digest is
# the linux/amd64 manifest pinned in ./image-lock.json and re-verified from the
# public.ecr.aws registry v2 API by scripts/verify-provenance.mts-adjacent tooling.
#
# The handler is a single esbuild bundle of ./container-entry.ts (platform=node, format=esm),
# produced by the gate before `podman build`. It is intentionally not committed.
FROM public.ecr.aws/lambda/nodejs:24@sha256:2472f0273d8848d8b2aa6528f5526b8a514b70703596199efe5a4b84d3d59b0b

COPY index.mjs ${LAMBDA_TASK_ROOT}/index.mjs

CMD [ "index.handler" ]
