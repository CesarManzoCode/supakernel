// The v1 claim registry (contract §31, Appendix B). Every public claim MUST carry the full
// tuple: claim → capability ID → contract section → real targets → command → immutable
// artifact → hash → result → known limitations. A claim absent from this registry is
// described as experimental / unsupported.

export type ClaimType = 'GATE' | 'EVIDENCE'

export interface Claim {
  readonly id: string
  readonly type: ClaimType
  readonly capabilityId: string
  readonly contractSection: string
  readonly realTargets: string
  /** The exact command that proves it. Run by `release:audit` (or its artifact is checked). */
  readonly command: string
  /** Where the immutable proof artifact lives, relative to repo root (glob ok). */
  readonly artifact: string
  readonly criterion: string
  readonly knownLimitations: string
  /** When true, `release:audit` only records the artifact + hash (the command is heavy /
   *  external and is run by the dedicated CI lane). */
  readonly artifactOnly?: boolean
}

export const CLAIMS: readonly Claim[] = [
  {
    id: 'build-reproducible',
    type: 'GATE',
    capabilityId: 'release.build',
    contractSection: '§26, §31, §33.2',
    realTargets: 'clean Linux x64 (+ arm64 in the release CI matrix)',
    command: "pnpm install --frozen-lockfile && pnpm build && git diff --exit-code -- ':!release'",
    artifact: 'release/manifest.json',
    criterion: 'same lockfile; tarball/SBOM hash per arch documented; clean generated diff',
    knownLimitations:
      'arm64 tarball hash is produced by the release workflow matrix, not this local x64 audit',
  },
  {
    id: 'package-boundaries',
    type: 'GATE',
    capabilityId: 'release.boundaries',
    contractSection: '§6.2, §31',
    realTargets: 'source graph',
    command: 'pnpm check:boundaries && pnpm typecheck',
    artifact: 'release/gates/package-boundaries.txt',
    criterion: 'zero forbidden edge / cycle / any; skipLibCheck:false everywhere',
    knownLimitations: 'none',
  },
  {
    id: 'postgresql-support',
    type: 'GATE',
    capabilityId: 'db.postgres',
    contractSection: '§9, §31',
    realTargets: 'PostgreSQL 18.6 real (127.0.0.1:55432)',
    command: 'pnpm test:db:postgres',
    artifact: 'release/gates/postgresql-support.txt',
    criterion: 'DB contract + services, zero unclassified',
    knownLimitations: 'none',
  },
  {
    id: 'sqlite-support',
    type: 'GATE',
    capabilityId: 'db.sqlite',
    contractSection: '§9, §31',
    realTargets: 'node:sqlite / bun:sqlite / D1 workerd / WASM Chromium',
    command: 'pnpm test:db:sqlite-matrix',
    artifact: 'release/gates/sqlite-support.txt',
    criterion: 'same family suite; declared capability only',
    knownLimitations:
      'bun / D1 / browser lanes require bun, wrangler+workerd, Playwright Chromium respectively',
  },
  {
    id: 'pglite-support',
    type: 'GATE',
    capabilityId: 'db.pglite',
    contractSection: '§9, §31',
    realTargets: 'PGlite 0.5.8 real',
    command: 'pnpm test:db:pglite',
    artifact: 'release/gates/pglite-support.txt',
    criterion: 'PG-family contract; divergences named',
    knownLimitations: 'none',
  },
  {
    id: 'runtime-portability',
    type: 'GATE',
    capabilityId: 'runtime.profiles',
    contractSection: '§10, §31',
    realTargets: '6 profiles (node / bun / deno / workers / browser / lambda)',
    command: 'pnpm test:runtime:all',
    artifact: 'labs/runtime-matrix/receipts',
    criterion: 'real receipt per profile; common core, no domain fork',
    knownLimitations:
      'lambda lane needs rootless podman + the locked base image; browser needs Chromium',
    artifactOnly: true,
  },
  {
    id: 'data-compatibility',
    type: 'GATE',
    capabilityId: 'data.postgrest',
    contractSection: '§11, §18, §19, §31',
    realTargets: 'Supabase local + kernel PG/SQLite',
    command: 'pnpm conformance --capability data',
    artifact: 'artifacts/conformance',
    criterion: 'all §11 scenarios match except registered intentional divergences',
    knownLimitations: 'RLS enforcement equivalence is the separate `authorization` gate (§13)',
  },
  {
    id: 'auth-compatibility',
    type: 'GATE',
    capabilityId: 'auth.gotrue',
    contractSection: '§12, §18, §19, §31',
    realTargets: 'GoTrue / Supabase local + kernel',
    command: 'pnpm conformance --capability auth',
    artifact: 'artifacts/conformance',
    criterion: '§12 endpoint/state/error observations match',
    knownLimitations: 'none',
  },
  {
    id: 'authorization',
    type: 'GATE',
    capabilityId: 'policy.rls',
    contractSection: '§13, §31',
    realTargets: 'PG direct RLS + SQLite rewrite',
    command: 'pnpm test:security:attacks',
    artifact: 'release/gates/authorization.txt',
    criterion: 'same rows/fields/decisions; full §13.2 attack catalog',
    knownLimitations: 'none',
  },
  {
    id: 'storage-compatibility',
    type: 'GATE',
    capabilityId: 'storage.compat',
    contractSection: '§14, §18, §19, §31',
    realTargets: 'Supabase local + FS/S3/R2/OPFS',
    command: 'pnpm conformance --capability storage',
    artifact: 'artifacts/conformance',
    criterion: 'bytes+metadata+range+policy; #64 fixed',
    knownLimitations:
      'storage-api 400-vs-404 on missing-object GET is a registered vendor quirk (see labs/upstream-evidence)',
  },
  {
    id: 'realtime-compatibility',
    type: 'GATE',
    capabilityId: 'realtime.changes',
    contractSection: '§15, §18, §19, §31',
    realTargets: 'client 2.115 + 4 listener runtimes + Supabase local',
    command: 'pnpm conformance --capability realtime',
    artifact: 'artifacts/conformance',
    criterion: 'ordered authorized changes; bounded queue',
    knownLimitations:
      'Realtime is a nightly conformance lane per §19.1; the 4 listener runtimes are proven by L10 receipts',
  },
  {
    id: 'management-mcp',
    type: 'GATE',
    capabilityId: 'management.mcp',
    contractSection: '§16, §31',
    realTargets: 'real MCP allowed tools',
    command: 'pnpm test:management:mcp',
    artifact: 'release/gates/management-mcp.txt',
    criterion: 'advertised allowlist succeeds; other tool clear error',
    knownLimitations:
      'the vendor Management API is hosted-only (opt-in); local check is kernel pg/sqlite self-consistency',
  },
  {
    id: 'openapi-types',
    type: 'GATE',
    capabilityId: 'release.generate',
    contractSection: '§26, §31',
    realTargets: 'generated from locked specs/schema',
    command: "pnpm generate && git diff --exit-code -- ':!release'",
    artifact: 'release/gates/openapi-types.txt',
    criterion: 'deterministic, no stale/unimplemented route',
    knownLimitations: 'none',
  },
  {
    id: 'migrations',
    type: 'GATE',
    capabilityId: 'schema.migrate',
    contractSection: '§17.1, §31',
    realTargets: 'all DB adapters',
    command: 'pnpm test:migrations:matrix',
    artifact: 'release/gates/migrations.txt',
    criterion: 'apply/introspect = idempotent desired state',
    knownLimitations: 'none',
  },
  {
    id: 'upgrade',
    type: 'GATE',
    capabilityId: 'schema.upgrade',
    contractSection: '§17.2, §31',
    realTargets: 'SupaKernel → Supabase local',
    command: 'pnpm test:upgrade:local',
    artifact: 'release/gates/upgrade.txt',
    criterion: 'rows + constraints + policies + auth + objects + 91→92 sequence',
    knownLimitations: 'needs the Supabase-local stack (podman + hc-loop)',
  },
  {
    id: 'properties',
    type: 'GATE',
    capabilityId: 'property.models',
    contractSection: '§20, §31',
    realTargets: '6 models, PG/SQLite',
    command: 'pnpm property:pr',
    artifact: 'release/gates/properties.txt',
    criterion: 'zero unclassified counterexample; regressions replay',
    knownLimitations:
      'this audit runs the PR scale (100 runs/model); `property:release` = 100k shards is the release-CI lane',
  },
  {
    id: 'semantic-mutation',
    type: 'GATE',
    capabilityId: 'mutation.semantic',
    contractSection: '§21, §31',
    realTargets: 'all manual critical mutants',
    command: 'pnpm mutation:semantic',
    artifact: 'release/gates/semantic-mutation.txt',
    criterion: '100% catalog killed',
    knownLimitations: 'none',
  },
  {
    id: 'generated-mutation',
    type: 'GATE',
    capabilityId: 'mutation.critical',
    contractSection: '§21, §31',
    realTargets: 'critical changed packages',
    command: 'pnpm mutation:critical',
    artifact: 'artifacts/mutation',
    criterion: 'zero unexplained survivors/timeouts',
    knownLimitations:
      'the @stryker-mutator/vitest-runner + vitest 5 + pnpm project-refs integration executes 0 tests/mutant in this environment; the binding gate (manual catalog, §21 gate 1 + Appendix A) is green',
    artifactOnly: true,
  },
  {
    id: 'fault-recovery',
    type: 'GATE',
    capabilityId: 'fault.recovery',
    contractSection: '§22, §31',
    realTargets: 'every named fault, hard restart',
    command: 'pnpm fault:all',
    artifact: 'release/gates/fault-recovery.txt',
    criterion: 'converge or honest blocked state; no invariant loss',
    knownLimitations:
      'the upgrade.* points need the Supabase-local stack; without it 19/24 points run',
  },
  {
    id: 'threat-redaction',
    type: 'GATE',
    capabilityId: 'security.redaction',
    contractSection: '§25, §26, §31',
    realTargets: 'canary secrets + attack corpus',
    command: 'pnpm security:audit',
    artifact: 'release/gates/threat-redaction.txt',
    criterion: 'no leak / escalation / cross-tenant access',
    knownLimitations: 'none',
  },
  {
    id: 'observability-replay',
    type: 'GATE',
    capabilityId: 'observability.replay',
    contractSection: '§19.2, §26, §31',
    realTargets: 'failure artifacts',
    command: 'pnpm artifacts:audit',
    artifact: 'release/gates/observability-replay.txt',
    criterion: '3 offline replays same normalized hash',
    knownLimitations: 'none',
  },
  {
    id: 'trace-audit',
    type: 'GATE',
    capabilityId: 'reference.traces',
    contractSection: '§18, §31',
    realTargets: 'four upstream gate chains',
    command: 'pnpm trace:audit',
    artifact: 'release/gates/trace-audit.txt',
    criterion: 'every trace pinned (SHA, symbols, license, own summary); #64 covered',
    knownLimitations: 'none',
  },
  // ---- EVIDENCE ----
  {
    id: 'bknd-performance',
    type: 'EVIDENCE',
    capabilityId: 'benchmark.bknd',
    contractSection: '§23, §31',
    realTargets: 'capability intersection, node+sqlite',
    command: 'pnpm benchmark:run',
    artifact: 'artifacts/benchmarks',
    criterion: 'validator pass + IC; claim only under §23 rules',
    knownLimitations:
      'SHARED runner — no "faster than BKND" claim (needs a dedicated runner); the report records the environment and returns an inconclusive verdict',
    artifactOnly: true,
  },
  {
    id: 'agent-dx',
    type: 'EVIDENCE',
    capabilityId: 'eval.agent-dx',
    contractSection: '§24, §31, §32',
    realTargets: 'fixed-model A/B, ≥10 runs',
    command: 'pnpm eval:agent',
    artifact: 'artifacts/agent-evals',
    criterion: 'success improves, no security regression',
    knownLimitations:
      'EXTERNAL BLOCKER: a real A/B DX comparison needs an LLM provider credential (ANTHROPIC_API_KEY, owner-supplied, §32). The harness is validated with a deterministic scripted agent; NO DX CLAIM is made.',
    artifactOnly: true,
  },
  {
    id: 'external-ownership',
    type: 'EVIDENCE',
    capabilityId: 'upstream.contribution',
    contractSection: '§28, §31, §32',
    realTargets: 'foreign maintainer',
    command: 'pnpm evidence:bundle',
    artifact: 'artifacts/upstream-evidence',
    criterion: 'accepted/merged material issue-fix, linked regression',
    knownLimitations:
      'EXTERNAL: upstream acceptance is not fabricated. One evidence bundle from a real, 3×-replayed divergence (supabase/storage 400-vs-404) is produced; submission + acceptance require human review (§32).',
    artifactOnly: true,
  },
  {
    id: 'supalite-divergences',
    type: 'EVIDENCE',
    capabilityId: 'blackbox.supalite',
    contractSection: '§19.1, §31',
    realTargets: 'black-box supalite 0.10.0',
    command: 'pnpm conformance:nightly (SUPAKERNEL_CONF_SUPALITE=1)',
    artifact: 'artifacts/conformance',
    criterion: '#64/#69 replay, not counted as kernel pass',
    knownLimitations:
      'the supalite lane requires a vendored supalite@0.10.0 kept out of the frozen lockfile; #64/#69 are documented in labs/reference-traces + labs/upstream-evidence',
    artifactOnly: true,
  },
]
