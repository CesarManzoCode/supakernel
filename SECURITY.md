# Security policy

## Reporting

Report suspected vulnerabilities privately through GitHub Security Advisories on
`CesarManzoCode/supakernel`. Do not open a public issue for an unfixed vulnerability. Include a
minimal reproduction, affected versions / commit, and impact. Describe the class of problem;
do not attach a working end-to-end exploit or an extraction path.

We aim to acknowledge within 3 working days and to ship a fix or mitigation for confirmed
exploitable critical / high issues before public disclosure.

## Threat model

The full model is contract §25. Summary:

- **Assets:** tenant data, passwords, signing / API / management keys, refresh-token families,
  object bytes and metadata, policies and schema, migration receipts, conformance secrets.
- **Adversaries:** anonymous remote, malicious authenticated user, neighbouring tenant, stolen
  access / refresh token, compromised object URL, malicious eval agent, operator error.
  Database / blob operator compromise is out of scope for v1 but partially detectable via
  hashes.

## Mandatory controls

- TLS is a deployment requirement; non-loopback HTTP without an explicit dev flag fails startup.
- CORS is an exact allowlist; no credentialed wildcard. `Host` / `Forwarded` never define a
  tenant without trusted-proxy configuration.
- WebCrypto CSPRNG, constant-time hash comparison, key rotation with `kid`. Secrets never
  appear in CLI args, artifacts or logs.
- Parameterised SQL only; the single permitted interpolation is a `SchemaIR`-validated,
  dialect-quoted identifier. Statement / time / row / body limits are enforced.
- RLS / policies and field gates run before I/O. Service and management audiences are separate.
- Object paths are canonicalised once; adapters receive the canonical key, never the user path.
- Append-only audit of auth / admin / migration / upgrade events, never containing secrets.
- Exact dependency versions, frozen lockfile, provenance / SBOM. `pnpm audit` is informative;
  OSV findings block for exploitable critical / high after documented triage.
- Eval / conformance child processes: network denied by default, read-only fixtures, no
  inherited cloud / Docker / SSH / GitHub tokens, CPU / memory quotas.

## Redaction

Observability events are redacted before emission: never Auth bodies, JWTs, passwords, API
keys or object bytes. Redaction is independent of log level and is tested with injected canary
secrets.
