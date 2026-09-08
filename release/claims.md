# SupaKernel v1 — supported claims

> Every public claim below carries the full evidence tuple required by the contract
> (Appendix B): **claim → capability ID → contract section → real targets → command →
> immutable artifact → hash → result → known limitations**. The machine-readable form is
> `release/manifest.json`; the §31 acceptance outcome is `release/acceptance.json`. Regenerate
> with `pnpm release:audit`.
>
> A claim **not** listed here is experimental / unsupported. Nothing in this file is
> published — the packages remain `private` and the final name / brand / registry scope
> require human review (contract §32).

## GATE claims (a v1 release requires every row)

| Claim | Capability | Contract | Real targets | Command |
|---|---|---|---|---|
| build reproducible | `release.build` | §26, §31, §33.2 | clean Linux x64 (+ arm64 in the release CI matrix) | `pnpm install --frozen-lockfile && pnpm build && git diff --exit-code` |
| package boundaries | `release.boundaries` | §6.2, §31 | source graph | `pnpm check:boundaries && pnpm typecheck` |
| PostgreSQL support | `db.postgres` | §9, §31 | PostgreSQL 18.6 real | `pnpm test:db:postgres` |
| SQLite support | `db.sqlite` | §9, §31 | node:sqlite / bun:sqlite / D1 workerd / WASM Chromium | `pnpm test:db:sqlite-matrix` |
| PGlite support | `db.pglite` | §9, §31 | PGlite 0.5.8 real | `pnpm test:db:pglite` |
| runtime portability | `runtime.profiles` | §10, §31 | 6 real profile receipts | `pnpm test:runtime:all` |
| Data compatibility | `data.postgrest` | §11, §18, §19, §31 | Supabase local + kernel PG/SQLite | `pnpm conformance --capability data` |
| Auth compatibility | `auth.gotrue` | §12, §18, §19, §31 | GoTrue / Supabase local + kernel | `pnpm conformance --capability auth` |
| authorization | `policy.rls` | §13, §31 | PG-direct RLS + SQLite rewrite | `pnpm test:security:attacks` |
| Storage compatibility | `storage.compat` | §14, §18, §19, §31 | Supabase local + FS/S3/R2/OPFS | `pnpm conformance --capability storage` |
| Realtime compatibility | `realtime.changes` | §15, §18, §19, §31 | client 2.115 + 4 listener runtimes + Supabase local | `pnpm conformance --capability realtime` |
| Management / MCP | `management.mcp` | §16, §31 | real MCP allowed tools | `pnpm test:management:mcp` |
| OpenAPI / types | `release.generate` | §26, §31 | generated from locked specs/schema | `pnpm generate && git diff --exit-code` |
| migrations | `schema.migrate` | §17.1, §31 | all DB adapters | `pnpm test:migrations:matrix` |
| upgrade | `schema.upgrade` | §17.2, §31 | SupaKernel → Supabase local | `pnpm test:upgrade:local` |
| properties | `property.models` | §20, §31 | 6 models, PG/SQLite | `pnpm property:pr` (release CI: `property:release`) |
| semantic mutation | `mutation.semantic` | §21, §31 | all manual critical mutants | `pnpm mutation:semantic` |
| generated mutation | `mutation.critical` | §21, §31 | critical changed packages | `pnpm mutation:critical` |
| fault / recovery | `fault.recovery` | §22, §31 | every named fault, hard restart | `pnpm fault:all` |
| threat / redaction | `security.redaction` | §25, §26, §31 | canary secrets + attack corpus | `pnpm security:audit` |
| observability / replay | `observability.replay` | §19.2, §26, §31 | failure artifacts | `pnpm artifacts:audit` |
| reference traces | `reference.traces` | §18, §31 | four upstream gate chains | `pnpm trace:audit` |

## EVIDENCE claims (do not block the release; block only the comparative claim they support)

| Claim | Capability | Contract | Note |
|---|---|---|---|
| BKND performance | `benchmark.bknd` | §23, §31 | validator PASS + bootstrap CI recorded. On a **shared** runner the verdict is inconclusive and **no "faster than BKND" claim is made**; a competitive claim needs a dedicated runner. |
| Agent DX | `eval.agent-dx` | §24, §31, §32 | **EXTERNAL BLOCKER** — a fixed-model A/B DX comparison needs an LLM provider credential (`ANTHROPIC_API_KEY`, owner-supplied). The harness (tasks, disposable credential-stripped sandbox, hidden state-based scorer, security probes, tamper resistance, provider abstraction) is validated with a deterministic scripted agent; **NO DX CLAIM**. |
| external ownership | `upstream.contribution` | §28, §31, §32 | One evidence bundle from a **real, 3×-replayed** divergence (`supabase/storage` returns HTTP 400 instead of 404 for GET of a missing object). Submission + upstream acceptance require human review and are **not fabricated**. |
| Supalite divergences | `blackbox.supalite` | §19.1, §31 | #64 / #69 documented in `labs/reference-traces` + `labs/upstream-evidence`. The live black-box lane needs a vendored `supalite@0.10.0` kept out of the frozen lockfile; its divergences are never counted as a kernel pass. |

## Signed tag

A signed release tag is created **locally only** by the release workflow when an authorized
signing identity is configured. This audit does not create or push a tag. If no signing
identity is available, that is reported as an external blocker rather than a fabricated
signature (contract §32, §33.4).
