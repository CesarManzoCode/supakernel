# regression: upgrade sequence 91 -> 92 (and supabase issue #69)

After an upgrade of a project whose `events` identity sequence has `max(id) = 91`, the
target's `nextval('events_id_seq')` MUST return `92` — the sequence state is read from the
real sequence (PG) or `MAX(id)` (SQLite), never inferred from the SQLite identity default
text (`/* sk:identity:x */ '0'`).

Pinned by:
- `labs/faults/test/upgrade.local.test.ts` — "the mandatory 91 -> 92 fixture"
- `labs/faults/src/upgrade-fixture.ts` — `UPGRADE_FIXTURE_EVENTS` (91 rows) + `events_id_seq`
- `packages/schema/src/upgrade/{export,import,verify}.ts` — `readSequences` / `phaseSequences` / `sequence:` invariant

Sequence ownership/introspection persists even when a source SQLite translated `bigserial`
(supabase issue #69); the divergence against Supalite 0.10.0 is recorded as an external
`supalite_divergence`, not a kernel result.
