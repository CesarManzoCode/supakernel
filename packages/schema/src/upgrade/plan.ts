// Phase `plan` + `readiness` (contract §17.2). Read-only. Produces an `UpgradePlan` with an
// explicit refusal list; `canProceed` is false if any hard-refusal condition holds.

import type { Json, SchemaIR } from '@supakernel/contracts'
import { isPortableType, PORTABLE_TYPES, sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { fingerprintSource, type StorageReader } from './export.js'
import { UPGRADE_PHASES, type UpgradePlan, type UpgradeRefusal } from './types.js'

const SUPABASE_SYSTEM_SCHEMAS = new Set([
  'auth',
  'storage',
  'realtime',
  'supabase_functions',
  'supabase_migrations',
  'graphql',
  'graphql_public',
  'extensions',
  'pgbouncer',
  'vault',
  'pgsodium',
  'net',
  '_realtime',
  '_analytics',
])

async function inspectTarget(
  target: DatabaseAdapter,
): Promise<{ nonEmpty: boolean; systemSchemasPresent: boolean; userTables: string[] }> {
  if (target.capabilities.family !== 'postgres') {
    return { nonEmpty: false, systemSchemasPresent: false, userTables: [] }
  }
  const rows = await target
    .execute(
      sql(
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      ),
    )
    .then((r) => (r.rows ?? []) as { schemaname: string; tablename: string }[])
  const userTables = rows
    .filter((r) => !SUPABASE_SYSTEM_SCHEMAS.has(r.schemaname))
    .map((r) => `${r.schemaname}.${r.tablename}`)
  const systemSchemasPresent =
    rows.some((r) => r.schemaname === 'auth') && rows.some((r) => r.schemaname === 'storage')
  return { nonEmpty: userTables.length > 0, systemSchemasPresent, userTables }
}

export interface PlanUpgradeInput {
  readonly source: DatabaseAdapter
  readonly target: DatabaseAdapter
  readonly schema: SchemaIR
  readonly policies: Json
  readonly storage: StorageReader
  readonly now: () => string
  readonly planId: string
  /** A mapping file the operator supplied to adopt a non-empty target. */
  readonly targetMapping?: boolean
  /** The operator asked to preserve sessions and supplied a legacy signing key. */
  readonly preserveSessions?: boolean
  readonly legacySecretStrength?: 'strong' | 'weak' | 'absent'
  /** Buckets/paths the source expects blob bytes for. */
  readonly missingBlobPaths?: readonly string[]
}

export async function planUpgrade(input: PlanUpgradeInput): Promise<UpgradePlan> {
  const refusals: UpgradeRefusal[] = []

  // 1. unsupported schema type / policy / object adapter — hard refusal before cutover.
  for (const t of input.schema.tables) {
    for (const c of t.columns) {
      if (!isPortableType(c.type)) {
        refusals.push({
          code: 'SK_UPGRADE_UNSUPPORTED_TYPE',
          reason: `${t.name}.${c.name} has non-portable type ${c.type} (portable: ${PORTABLE_TYPES.join(', ')})`,
        })
      }
    }
  }

  // 2. target non-empty without a mapping file.
  const target = await inspectTarget(input.target)
  if (target.nonEmpty && !input.targetMapping) {
    refusals.push({
      code: 'SK_UPGRADE_TARGET_NONEMPTY',
      reason: `target has ${target.userTables.length} pre-existing user table(s): ${target.userTables.slice(0, 5).join(', ')} — supply a mapping file or use a disposable target`,
    })
  }

  // 3. session preservation requested but the legacy secret is weak / absent.
  if (input.preserveSessions && input.legacySecretStrength !== 'strong') {
    refusals.push({
      code: 'SK_UPGRADE_WEAK_LEGACY_SECRET',
      reason:
        'session continuity requires a strong legacy signing key; refuse rather than downgrade auth',
    })
  }

  // 4. a storage object the source references has no bytes.
  for (const p of input.missingBlobPaths ?? []) {
    refusals.push({ code: 'SK_UPGRADE_MISSING_BLOB', reason: `object bytes unavailable: ${p}` })
  }

  const source = await fingerprintSource(input.source, input.schema, input.storage)

  return {
    id: input.planId,
    createdAt: input.now(),
    source,
    target: { nonEmpty: target.nonEmpty, systemSchemasPresent: target.systemSchemasPresent },
    phases: [...UPGRADE_PHASES],
    refusals,
    canProceed: refusals.length === 0,
  }
}
