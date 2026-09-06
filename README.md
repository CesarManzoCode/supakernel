# SupaKernel

A lightweight TypeScript backend runtime that offers an explicit subset of Supabase
Data / Auth / Storage / Realtime / Management over **PostgreSQL** and **SQLite**, through a
single runtime-independent semantic core, and proves each promise by running the same
scenario against real implementations, faults, attacks and environments.

> **Status:** implementation in progress. The normative source of truth is
> [`docs/SupaKernel-Contract.md`](docs/SupaKernel-Contract.md). Nothing in this repository is a
> supported capability until the executable proof defined in the contract passes.

## Layout

| Path | Purpose |
|---|---|
| `packages/contracts` | Canonical types, JSON Schemas, `KernelError`. Dependency-free. |
| `packages/ports` | DB / blob / runtime / crypto / clock / random / fault / mail / changefeed interfaces. |
| `packages/ports-test` | Test-only shared Database connection contract suite. |
| `packages/schema` | `SchemaIR`, PG AST → IR, normalize, diff, plan, apply, journal, dialects, introspection. |
| `packages/policy` … `packages/runtime-*` | Later Sprint layers (see contract §29–30). |
| `packages/db-postgres` `db-pglite` `db-sqlite` | Real database adapters. |
| `labs/*` | Conformance, reference traces, faults, mutation, benchmarks, agent evals, upstream evidence. |
| `vendor-lock/` | Real source SHAs, image digests, npm integrities, runtime download hashes. No vendored source. |
| `scripts/` | `lock-vendors`, `verify-provenance`, `check-boundaries`, `schema-lock`. |

## Toolchain

Pinned exactly (contract §33.1). Node 24.20.0 LTS is the baseline; Bun 1.4.1 and Deno 2.9.6
are real alternate runtimes; Wrangler 4.129.0 / workerd and Playwright 1.63.0 Chromium provide
real edge and browser targets. Package management is pnpm 11.25.0 via Corepack.

```sh
corepack pnpm install --frozen-lockfile
pnpm verify:provenance
pnpm check:boundaries
pnpm typecheck
pnpm lint
pnpm test
```

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
