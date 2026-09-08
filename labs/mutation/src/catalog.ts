// Manual semantic mutant catalog (contract §21.1). 100% kill is mandatory — if any of these
// mutations could survive the test suite, a release is impossible. The policy mutants live in
// `packages/policy/test/semantic-mutants.test.ts` (L4); this catalog covers auth, storage,
// schema/migrate and realtime, exercised by `labs/mutation/test/semantic-mutants.test.ts`.

export interface SemanticMutant {
  readonly id: string
  readonly area: 'policy' | 'auth' | 'storage' | 'schema' | 'realtime'
  /** The behaviour a mutation would introduce. */
  readonly mutation: string
  /** The test that must fail if the mutation is present. */
  readonly killedBy: string
}

export const SEMANTIC_MUTANTS: readonly SemanticMutant[] = [
  // ---- policy (owned by packages/policy/test/semantic-mutants.test.ts) ----
  {
    id: 'policy.allow-deny-swap',
    area: 'policy',
    mutation: 'allow <-> deny',
    killedBy: 'packages/policy semantic-mutants',
  },
  {
    id: 'policy.default-allow',
    area: 'policy',
    mutation: 'no rule -> allow instead of deny',
    killedBy: 'packages/policy semantic-mutants',
  },
  {
    id: 'policy.drop-tenant-predicate',
    area: 'policy',
    mutation: 'remove the tenant/owner predicate',
    killedBy: 'packages/policy semantic-mutants',
  },
  {
    id: 'policy.trust-body-role',
    area: 'policy',
    mutation: 'trust a role/tenant in the request body',
    killedBy: 'packages/policy semantic-mutants',
  },
  {
    id: 'policy.drop-field-gate',
    area: 'policy',
    mutation: 'ignore readable/writable/immutable field gate',
    killedBy: 'packages/policy semantic-mutants',
  },
  {
    id: 'policy.omit-with-check',
    area: 'policy',
    mutation: 'skip WITH CHECK on write',
    killedBy: 'packages/policy semantic-mutants',
  },
  {
    id: 'policy.and-or-flip',
    area: 'policy',
    mutation: 'flip AND/OR of combined policies',
    killedBy: 'packages/policy semantic-mutants',
  },
  // ---- auth ----
  {
    id: 'auth.accept-alg-none',
    area: 'auth',
    mutation: 'accept alg=none JWTs',
    killedBy: 'semantic-mutants > auth alg=none is rejected',
  },
  {
    id: 'auth.wrong-aud',
    area: 'auth',
    mutation: 'accept a token with the wrong audience',
    killedBy: 'semantic-mutants > auth wrong aud is rejected',
  },
  {
    id: 'auth.accept-expired',
    area: 'auth',
    mutation: 'accept an expired token',
    killedBy: 'semantic-mutants > auth expired token is rejected',
  },
  {
    id: 'auth.skip-session-revocation',
    area: 'auth',
    mutation: 'do not check session revocation on verify',
    killedBy: 'semantic-mutants > revoked session cannot verify',
  },
  {
    id: 'auth.refresh-cas-to-unconditional',
    area: 'auth',
    mutation: 'refresh CAS -> unconditional UPDATE',
    killedBy: 'semantic-mutants > concurrent refresh yields one child',
  },
  {
    id: 'auth.no-family-revoke-on-reuse',
    area: 'auth',
    mutation: 'reused refresh token does not revoke the family',
    killedBy: 'semantic-mutants > reuse revokes the family',
  },
  // ---- storage ----
  {
    id: 'storage.ready-before-bytes',
    area: 'storage',
    mutation: 'mark ready before bytes+hash are verified',
    killedBy: 'semantic-mutants > only ready+hash is served',
  },
  {
    id: 'storage.signed-token-any-path',
    area: 'storage',
    mutation: 'signed token without an exact path/method bind',
    killedBy: 'semantic-mutants > signed token is path/method bound',
  },
  // ---- schema / migrate ----
  {
    id: 'schema.sequence-reset-omitted',
    area: 'schema',
    mutation: 'omit / off-by-one the sequence setval',
    killedBy: 'semantic-mutants > upgraded sequence nextval > max',
  },
  {
    id: 'schema.journal-postcondition-omitted',
    area: 'schema',
    mutation: 'skip the migration journal postcondition',
    killedBy: 'semantic-mutants > a failed step is not marked applied',
  },
  // ---- realtime ----
  {
    id: 'realtime.no-policy-on-change',
    area: 'realtime',
    mutation: 'deliver a change without re-checking the policy',
    killedBy: 'semantic-mutants > realtime respects row policy',
  },
  {
    id: 'realtime.no-backpressure',
    area: 'realtime',
    mutation: 'unbounded outbound queue (no 1013 close)',
    killedBy: 'semantic-mutants > realtime bounded queue closes with 1013',
  },
]
