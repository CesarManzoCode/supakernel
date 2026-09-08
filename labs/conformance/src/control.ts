// Control channel (contract §19.2): the out-of-band setup + state-capture path for a target.
// This is explicitly per-target — the prohibition on target-specific branching applies to the
// common runner and the operation interpreter, not to provisioning.

import type {
  Column,
  Json,
  JsonObject,
  ScenarioSpec,
  ScenarioStep,
  SchemaIR,
  Table,
} from '@supakernel/contracts'
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

/** Every table a scenario declares via `schema.createTable`. */
export function scenarioTables(scenario: ScenarioSpec): PortableTable[] {
  return scenario.setup
    .filter((s) => s.action === 'schema.createTable')
    .map((s) => portableTableFromStep(s))
}

/**
 * Rewrite every table reference in a scenario with a run-unique suffix. PostgREST reloads its
 * schema cache asynchronously; if two scenarios repeatedly `DROP`+`CREATE` the same table
 * name the oracle can serve a stale cache mid-reload. A per-run table name means the oracle
 * only ever *adds* tables, so the reload is monotonic and never races an operation.
 */
export interface UniquifiedScenario {
  readonly scenario: ScenarioSpec
  /** unique table name -> canonical base name, for normalization back to a stable golden. */
  readonly aliases: Readonly<Record<string, string>>
}

export function uniquifyScenarioTables(scenario: ScenarioSpec, suffix: string): UniquifiedScenario {
  const names = new Set(scenarioTables(scenario).map((t) => t.name))
  const aliases: Record<string, string> = {}
  for (const n of names) aliases[`${n}_${suffix}`] = n
  const rename = (n: unknown): unknown =>
    typeof n === 'string' && names.has(n) ? `${n}_${suffix}` : n
  const fixStep = (step: ScenarioStep): ScenarioStep => {
    const input = { ...stepInput(step) } as Record<string, unknown>
    if ('name' in input) input.name = rename(input.name)
    if ('table' in input) input.table = rename(input.table)
    return { ...step, input: input as ScenarioStep['input'] }
  }
  const rewritten: ScenarioSpec = {
    ...scenario,
    setup: scenario.setup.map(fixStep),
    operations: scenario.operations.map(fixStep),
    observe: scenario.observe.map((o) => {
      const sel = o.selector
      if (sel && typeof sel === 'object' && !Array.isArray(sel) && 'table' in sel) {
        return {
          ...o,
          selector: {
            ...sel,
            table: rename((sel as Record<string, unknown>).table),
          } as ScenarioSpec['observe'][number]['selector'],
        }
      }
      return o
    }),
  }
  return { scenario: rewritten, aliases }
}

const PORTABLE_TO_IR = {
  text: 'text',
  int: 'int32',
  bool: 'bool',
  timestamptz: 'timestamptz',
} as const

function portableDefault(raw: string | null | undefined): Column['default'] {
  if (raw == null) return null
  if (raw === 'true' || raw === 'false') return { kind: 'literal', value: raw === 'true' }
  if (/^-?\d+$/.test(raw)) return { kind: 'literal', value: Number(raw) }
  return { kind: 'literal', value: raw.replace(/^'|'$/g, '') }
}

/** Build the SchemaIR a kernel target needs so its schema-driven Data handler knows the
 *  scenario's tables (contract §11 — the Data handler is schema-bound). */
export function scenarioSchemaIR(scenario: ScenarioSpec): SchemaIR {
  const tables: Table[] = scenarioTables(scenario).map((t) => ({
    name: t.name,
    columns: t.columns.map(
      (c): Column => ({
        name: c.name,
        type: PORTABLE_TO_IR[c.type],
        nullable: c.nullable !== false,
        default: portableDefault(c.default),
        generated: false,
      }),
    ),
    primaryKey: [...t.primaryKey],
    uniques: (t.unique ?? []).map((cols, i) => ({ name: `${t.name}_uq_${i}`, columns: [...cols] })),
    foreignKeys: [],
    checks: [],
    indexes: [],
  }))
  return { version: 1, tables, sequences: [], policies: [] }
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
