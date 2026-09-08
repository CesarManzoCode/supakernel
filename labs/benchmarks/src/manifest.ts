// The strict common workload (contract §23.1). No RLS / Auth / Storage — only the capability
// intersection with BKND: a single flat table, 10k rows, HTTP JSON CRUD, equality filter on
// an indexed column, pagination, insert / update / delete.

export interface WorkloadOp {
  readonly id: string
  readonly kind: 'list' | 'get' | 'page' | 'insert' | 'update' | 'delete'
  readonly input: Record<string, unknown>
}

export const WORKLOAD_TABLE = 'todos'

export interface WorkloadSchema {
  readonly table: string
  readonly columns: readonly {
    readonly name: string
    readonly type: string
    readonly indexed?: boolean
  }[]
  readonly rows: number
  readonly tenants: number
}

export const WORKLOAD_SCHEMA: WorkloadSchema = {
  table: WORKLOAD_TABLE,
  columns: [
    { name: 'id', type: 'int-identity' },
    { name: 'tenant_id', type: 'text', indexed: true },
    { name: 'body', type: 'text' },
    { name: 'done', type: 'bool' },
    { name: 'created_at', type: 'timestamp' },
  ],
  rows: 10_000,
  tenants: 20,
}

/** Durability settings both systems MUST match before any timing (contract §23.1). */
export const REQUIRED_DURABILITY = {
  journalMode: 'WAL',
  foreignKeys: true,
  synchronous: 'NORMAL',
} as const

/** The fixed operation sequence the validator + warm load driver replay identically. */
export const WORKLOAD_OPS: readonly WorkloadOp[] = [
  { id: 'list-tenant-1', kind: 'list', input: { tenant_id: 't1' } },
  { id: 'get-id-42', kind: 'get', input: { id: 42 } },
  { id: 'page-0-24', kind: 'page', input: { tenant_id: 't2', offset: 0, limit: 25 } },
  { id: 'page-25-49', kind: 'page', input: { tenant_id: 't2', offset: 25, limit: 25 } },
  { id: 'insert-1', kind: 'insert', input: { tenant_id: 't3', body: 'a new todo', done: false } },
  { id: 'update-1', kind: 'update', input: { id: 100, done: true } },
  { id: 'delete-1', kind: 'delete', input: { id: 200 } },
] as const

export interface Environment {
  readonly cpuModel: string
  readonly cores: number
  readonly kernel: string
  readonly totalMemBytes: number
  readonly node: string
  readonly governor: string | null
  readonly dedicated: boolean
  readonly note: string
}
