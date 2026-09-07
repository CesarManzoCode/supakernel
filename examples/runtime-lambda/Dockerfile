# AWS Lambda (Node 24) container image for a SupaKernel deployment (contract §10, §30 L10).
# The base image digest is pinned in ./image-lock.json; CI resolves and verifies it at build.
FROM public.ecr.aws/lambda/nodejs:24@sha256:ba8267e65e24c53ab13256b11bd004a01e23c4ec7f0d5301522a57fba6868b63

# The handler is a single esbuild bundle (scripts/verify-bundles.mts, platform=node, format=esm).
COPY dist/index.mjs ${LAMBDA_TASK_ROOT}/index.mjs

CMD [ "index.handler" ]
