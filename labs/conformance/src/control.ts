// Control channel (contract §19.2): the out-of-band setup + state-capture path for a target.
// This is explicitly per-target — the prohibition on target-specific branching applies to the
// common runner and the operation interpreter, not to provisioning.

import type { Json, JsonObject, ScenarioStep } from '@supakernel/contracts'
import { stepInput } from './schema.js'

export interface PortableColumn {
  readonly name: string
  readonly type: 'text' | 'int' | 'bool' | 'timestamptz'
  readonly nullable?: boolean
  readonly default?: string | null
}
export interface PortableTable {
  readonly name: string
  readonly columns: readonly PortableColumn[]
  readonly primaryKey: readonly string[]
  readonly unique?: readonly (readonly string[])[]
}

export function portableTableFromStep(step: ScenarioStep): PortableTable {
  const input = stepInput(step)
  return input as unknown as PortableTable
}

/** Family-specific DDL for a portable table spec. */
export function createTableSql(table: PortableTable, family: 'postgres' | 'sqlite'): string {
  const typeMap = {
    postgres: { text: 'text', int: 'integer', bool: 'boolean', timestamptz: 'timestamptz' },
    sqlite: { text: 'TEXT', int: 'INTEGER', bool: 'SK_BOOL', timestamptz: 'SK_TEXT_TSTZ' },
  } as const
  const cols = table.columns.map((c) => {
    const parts = [`"${c.name}"`, typeMap[family][c.type]]
    if (c.nullable === false) parts.push('NOT NULL')
    if (c.default != null) parts.push(`DEFAULT ${c.default}`)
    return parts.join(' ')
  })
  cols.push(`PRIMARY KEY (${table.primaryKey.map((k) => `"${k}"`).join(', ')})`)
  for (const u of table.unique ?? []) cols.push(`UNIQUE (${u.map((k) => `"${k}"`).join(', ')})`)
  return `CREATE TABLE "${table.name}" (${cols.join(', ')})`
}

export interface ControlChannel {
  /** Family of the underlying database, so shared helpers can emit correct DDL. */
  readonly family: 'postgres' | 'sqlite'
  /** Drop everything the previous scenario created. */
  reset(): Promise<void>
  createTable(table: PortableTable): Promise<void>
  /** Deploy the scenario policies (RLS native on PG, rewrite check on SQLite). */
  deployPolicies(policies: Json): Promise<void>
  seed(table: string, rows: readonly JsonObject[]): Promise<void>
  adminCreateUser(user: { email: string; password: string; data?: JsonObject }): Promise<void>
  createBucket(bucket: { name: string; public?: boolean }): Promise<void>
  registerRealtimeTable(table: string): Promise<void>
  /** Capture a declared observation of side state (db-state / mail / object). */
  capture(of: string, selector: Json): Promise<Json>
}

export async function runSetupStep(channel: ControlChannel, step: ScenarioStep): Promise<void> {
  const input = stepInput(step)
  switch (step.action) {
    case 'schema.reset':
      await channel.reset()
      return
    case 'schema.createTable':
      await channel.createTable(portableTableFromStep(step))
      return
    case 'schema.deployPolicies':
      await channel.deployPolicies((input.policies ?? []) as Json)
      return
    case 'db.seed':
      await channel.seed(String(input.table), (input.rows ?? []) as JsonObject[])
      return
    case 'auth.adminCreateUser':
      await channel.adminCreateUser({
        email: String(input.email),
        password: String(input.password),
        ...(input.data ? { data: input.data as JsonObject } : {}),
      })
      return
    case 'storage.createBucket':
      await channel.createBucket({ name: String(input.name), public: input.public === true })
      return
    case 'realtime.registerTable':
      await channel.registerRealtimeTable(String(input.table))
      return
    default:
      throw new Error(`unknown setup action ${step.action}`)
  }
}
