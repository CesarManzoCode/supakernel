# SupaKernel quickstart

From an empty directory, five steps and under five human minutes (contract §27). The shell
block below is executed verbatim by `pnpm docs:test`.

```sh
node ./apps/cli/dist/main.js init
node ./apps/cli/dist/main.js doctor --json
node ./apps/cli/dist/main.js capabilities --json
node ./apps/cli/dist/main.js db diff --name initial
node ./apps/cli/dist/main.js types --lang typescript
```

Expected: `supakernel/config.ts` and `supakernel/schema/0001_init.sql` are created, `doctor`
and `capabilities` emit JSON, `db diff` prints a stable schema hash, and `types` prints a
`Database` TypeScript type generated from the schema.
