# AGENTS.md

Instructions for any coding agent (human or model) working in this repository.

## Authority

`docs/SupaKernel-Contract.md` is normative. "DEBE" / "NO DEBE" / "RECHAZAR" are acceptance
requirements. A capability claim only counts when the executable proof defined in the contract
passes against the real target.

## Non-negotiable rules

1. **Do not** change dependency pins, the package graph, the protocol subset, the security
   model, migration semantics, DB model, runtime abstraction, endpoints, or public
   discriminants. These are contract decisions, not implementation choices (§33.4).
2. **Do not** set `skipLibCheck: true` in any effective tsconfig.
3. **Do not** introduce `any`. Discriminated unions are exhaustive; `never` proves it.
4. **Do not** relax a test, normalizer, policy, durability setting, capability or redaction to
   make a gate pass. If a gate cannot pass honestly, stop with `BLOCKED`.
5. **Do not** invent SHAs, digests, npm integrities or provenance. Obtain real evidence via
   `pnpm lock:vendors` and the registry / GitHub APIs.
6. The only workspace package permitted outside the contract's package map is
   `packages/ports-test`.
7. `contracts` imports nothing. `ports` imports only `contracts`. `schema` and `policy` never
   import each other. Services never import Hono or concrete adapters. `db-*` / `blob-*` /
   `runtime-*` implement ports and are wired by composition only. `check:boundaries` enforces
   this.

## Workflow

```sh
source ~/.local/bin/sk-env.sh   # local dev only: userland Node/pnpm/bun/deno/postgres
corepack pnpm install --frozen-lockfile
pnpm verify:provenance && pnpm check:boundaries && pnpm typecheck && pnpm lint && pnpm test
```

Write / update the contract tests first, then the minimal complete implementation. Run every
command for the layer plus the affected gates of previous layers. Never edit baselines,
normalizers or capability manifests to hide a failure.

## Refusal / BLOCKED conditions

See contract §33.4. Respond `BLOCKED` with evidence and zero workaround when a decision in
§§4–17 would have to change, a version/source/digest does not match the lock, a required real
target or credential is unavailable, the worktree has un-preservable user changes, passing
requires relaxing an invariant, an operation would be destructive outside a disposable
fixture, or a registry / brand scope is not authorized for publish.
