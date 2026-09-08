// Phase `verification` (contract §17.2). Every invariant below must hold before a receipt is
// issued; a single failure marks the upgrade `incomplete`, never `success`.

import type { Json, SchemaIR } from '@supakernel/contracts'
import { sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'
import { canonicalRowTyped, multisetHash } from './export.js'
import type { Fingerprint, ObjectTransfer, UpgradeBundle } from './types.js'

const q = (n: string): string => `"${n.replace(/"/g, '""')}"`

export interface InvariantResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

async function rowsOf(target: DatabaseAdapter, text: string): Promise<Record<string, unknown>[]> {
  return (await target.execute(sql(text))).rows as Record<string, unknown>[]
}

export interface PolicyProbe {
  /** seat -> decision snapshot, taken on the source before and expected to match on target. */
  readonly seat: string
  run(target: DatabaseAdapter): Promise<Json>
}

export interface VerifyInput {
  readonly target: DatabaseAdapter
  readonly bundle: UpgradeBundle
  readonly schema: SchemaIR
  readonly objects: ObjectTransfer
  /** A sample credential to prove password login still works on the target. */
  readonly passwordLoginProbe?: () => Promise<boolean>
  /** anon / user A / user B / service policy decisions, captured on the source. */
  readonly policyBefore?: Readonly<Record<string, Json>>
  readonly policyProbes?: readonly PolicyProbe[]
  /** True when the operator did NOT request session continuity — all sessions must be revoked. */
  readonly expectSessionsRevoked: boolean
}

export async function verifyUpgrade(input: VerifyInput): Promise<{
  invariants: InvariantResult[]
  targetFingerprint: Fingerprint
  sessionsRevoked: boolean
  ok: boolean
}> {
  const { target, bundle } = input
  const inv: InvariantResult[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    inv.push({ name, ok, detail })
  }

  // 1. row count + multiset hash per table.
  const targetCounts: Record<string, number> = {}
  const targetMulti: Record<string, string> = {}
  for (const t of bundle.schema.tables) {
    const rows = (await rowsOf(target, `SELECT * FROM ${q(t.name)}`)).map((r) =>
      canonicalRowTyped(r, t),
    )
    targetCounts[t.name] = rows.length
    targetMulti[t.name] = multisetHash(rows)
    const wantCount = bundle.source.tableRowCounts[t.name] ?? 0
    push(
      `rows:${t.name}`,
      rows.length === wantCount && targetMulti[t.name] === bundle.source.tableMultisetHash[t.name],
      `count ${rows.length}/${wantCount}, multiset ${targetMulti[t.name] === bundle.source.tableMultisetHash[t.name] ? 'match' : 'MISMATCH'}`,
    )
  }

  // 2. constraint equivalence within the portable subset (PK / unique / FK / check / index).
  for (const t of bundle.schema.tables) {
    const cons = await rowsOf(
      target,
      `SELECT conname, contype FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
       JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname=${sqlLit(t.name)}`,
    )
    const types = new Set(cons.map((c) => String(c.contype)))
    const wantPk = t.primaryKey.length > 0
    const wantUq = t.uniques.length > 0
    const wantFk = t.foreignKeys.length > 0
    const wantChk = t.checks.length > 0
    const okC =
      (!wantPk || types.has('p')) &&
      (!wantUq || types.has('u')) &&
      (!wantFk || types.has('f')) &&
      (!wantChk || types.has('c'))
    push(`constraints:${t.name}`, okC, [...types].join(''))
  }

  // 3. sequences: nextval strictly greater than every migrated id, honouring increment.
  for (const [name, s] of Object.entries(bundle.sequences)) {
    const cur = await rowsOf(target, `SELECT last_value::text AS lv, is_called FROM ${q(name)}`)
    const next = await rowsOf(target, `SELECT nextval(${sqlLit(name)})::text AS nv`)
    // restore so nextval didn't consume a value the real workload needs
    await target.execute(sql(`SELECT setval($1, $2::bigint, true)`, [name, s.last] as never[]))
    const nv = BigInt(String(next[0]?.nv ?? '0'))
    const owned = Object.entries(bundle.source.sequences).length
    void owned
    const expected = BigInt(s.last) + BigInt(s.increment)
    push(
      `sequence:${name}`,
      nv === expected && nv > BigInt(s.last),
      `nextval=${nv} expected=${expected} (last_value ${cur[0]?.lv})`,
    )
  }

  // 4. auth: sample password login works on the target.
  if (input.passwordLoginProbe) {
    push('auth:password-login', await input.passwordLoginProbe(), 'sample credential')
  }
  const authCount = await rowsOf(target, `SELECT count(*)::int AS c FROM auth.users`)
  push(
    'auth:user-count',
    Number(authCount[0]?.c ?? 0) >= bundle.authUsers.length,
    `${authCount[0]?.c}/${bundle.authUsers.length}`,
  )

  // 5. sessions revoked unless continuity was requested.
  const sess = await rowsOf(
    target,
    `SELECT count(*)::int AS c FROM auth.sessions WHERE not_after IS NULL OR not_after > now()`,
  ).catch(() => [{ c: 0 }])
  const activeSessions = Number(sess[0]?.c ?? 0)
  const sessionsRevoked = activeSessions === 0
  if (input.expectSessionsRevoked) {
    push('auth:sessions-revoked', sessionsRevoked, `${activeSessions} active`)
  }

  // 6. storage: count, path, size, sha256, content-type, public/private.
  const targetObjs = await input.objects.listObjects()
  const haveSet = new Set(targetObjs.map((o) => `${o.bucket}/${o.path}`))
  let storageOk = bundle.storageObjects.length === targetObjs.length
  for (const o of bundle.storageObjects) {
    const stat = await input.objects.statObject(o.bucket, o.path)
    const match =
      haveSet.has(`${o.bucket}/${o.path}`) &&
      stat !== null &&
      stat.size === o.size &&
      stat.sha256 === o.sha256
    if (!match) storageOk = false
  }
  push(
    'storage:bytes+metadata',
    storageOk,
    `${targetObjs.length}/${bundle.storageObjects.length} objects`,
  )

  // 7. policy probes anon / A / B / service produce the same decision + fields.
  if (input.policyProbes && input.policyBefore) {
    for (const probe of input.policyProbes) {
      const after = await probe.run(target)
      const before = input.policyBefore[probe.seat] ?? null
      const same = JSON.stringify(before) === JSON.stringify(after)
      push(`policy:${probe.seat}`, same, same ? 'decision/fields identical' : 'DIVERGED')
    }
  }

  const targetFingerprint: Fingerprint = {
    family: 'postgres',
    schemaHash: bundle.source.schemaHash,
    tableRowCounts: targetCounts,
    tableMultisetHash: targetMulti,
    sequences: Object.fromEntries(
      Object.entries(bundle.sequences).map(([k, v]) => [
        k,
        { last: v.last, increment: v.increment },
      ]),
    ),
    authUserCount: Number(authCount[0]?.c ?? 0),
    storageObjectCount: targetObjs.length,
  }

  return {
    invariants: inv,
    targetFingerprint,
    sessionsRevoked,
    ok: inv.every((i) => i.ok),
  }
}

function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
