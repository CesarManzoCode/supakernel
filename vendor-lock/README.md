# vendor-lock/

Machine-generated evidence locks. **No vendored source lives here** — only identifiers and
cryptographic digests.

| File | Contents |
|---|---|
| `sources.json` | Referenced upstream repositories: public URL, 40-char commit SHA, license, evidence cutoff. |
| `images.json` | Container images used by the local vendor stack: reference + `sha256:` manifest digest. |
| `packages.json` | Every pinned npm dependency: exact version, resolved tarball, `sha512` integrity, registry publish timestamp. |
| `runtimes.json` | Language / edge runtimes: version, official download URL, `sha256`. |

Regenerate with `pnpm lock:vendors` (idempotent — a second run produces no diff). Validate with
`pnpm verify:provenance`. The input set is defined at the top of `scripts/lock-vendors.mts`.
