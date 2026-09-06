# Contributing to SupaKernel

## Ground rules

1. Read [`docs/SupaKernel-Contract.md`](docs/SupaKernel-Contract.md) and [`AGENTS.md`](AGENTS.md)
   first. The contract is normative and is not up for redesign in a PR.
2. One DAG layer per change set (contract §29). A layer may not anticipate an interface from a
   later layer.
3. Every capability claim needs the full evidence tuple: `claim → capability ID → contract
   section → real targets → command → immutable artifact → hash → result → known limitations`
   (Appendix B). A mock, an adapter or a test alone satisfies nothing.

## Environment

Toolchain versions are pinned exactly in `.tool-versions` and `package.json`. Use Corepack for
pnpm. On a bare machine the userland bootstrap is Node / pnpm / Bun / Deno / PostgreSQL 18.6
under `~/.local`; `source ~/.local/bin/sk-env.sh` if present.

```sh
corepack pnpm install --frozen-lockfile
pnpm verify:provenance
pnpm check:boundaries
pnpm typecheck
pnpm lint
pnpm test
```

## Dependency changes

- Exact versions only, no `^` / `~`. `pnpm-lock.yaml` and npm integrities are normative.
- Adding or bumping a dependency: update the manifest, run `pnpm lock:vendors`, commit the
  regenerated `vendor-lock/*.json`, and ensure `pnpm verify:provenance` passes. The 72-hour
  age gate applies; a `package@exact-version` bootstrap exception is allowed only when the
  registry publish timestamp proves it was necessary when the lock was created.

## Tests

- Contract tests come before implementation.
- No `it.only`, no `.skip` in committed code, no TODO left in a "DONE" layer.
- `git diff --exit-code` must be clean after `pnpm lock:vendors`, `pnpm generate` and
  `pnpm schema:lock`.

## Commit / PR style

- Descriptive commit subjects (`feat(schema): …`, `test(db): …`). No `wip` / `fix2` / `final`.
- PRs run the PR CI lane (contract §33.2). Environment-failed lanes are re-run in a healthy
  environment; a previous real failure is not erased by a retry.

## License

By contributing you agree your contribution is licensed under Apache-2.0. Behavioural
reimplementation of referenced systems is fine; copied source under an incompatible license is
not.
