# AWS Lambda (Node 24) container image for a SupaKernel deployment (contract §10, §30 L10).
# The base image digest is pinned in ./image-lock.json; CI resolves and verifies it at build.
FROM public.ecr.aws/lambda/nodejs:24@sha256:a63325781135a23612aa8b29e659b9bd59e214dcb95ca8e05c5a76545edf28b1

# The handler is a single esbuild bundle (scripts/verify-bundles.mts, platform=node, format=esm).
COPY dist/index.mjs ${LAMBDA_TASK_ROOT}/index.mjs

CMD [ "index.handler" ]
