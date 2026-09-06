import type {
  DatabaseCapabilities,
  DbResult,
  ObservedSchema,
  RuntimeId,
  SqlStatement,
  Transaction,
  TransactionOptions,
} from '@supakernel/contracts'

/**
 * The persistence trusted computing base (contract §8, §9). Every adapter runs the identical
 * connection-contract suite; a domain branch keyed on `adapter.id` is forbidden — only the
 * dialect compiler may branch on `family`, and the adapter on a primitive capability.
 */
export interface DatabaseAdapter extends AsyncDisposable {
  readonly id: string
  readonly runtime: RuntimeId
  readonly capabilities: DatabaseCapabilities

  execute(statement: SqlStatement, tx?: Transaction): Promise<DbResult>
  transaction<T>(options: TransactionOptions, fn: (tx: Transaction) => Promise<T>): Promise<T>
  atomicBatch(statements: readonly SqlStatement[]): Promise<readonly DbResult[]>
  introspect(): Promise<ObservedSchema>
  close(): Promise<void>
}

/** A factory that opens one adapter against a concrete resource (file path, URL, binding …). */
export interface DatabaseAdapterFactory {
  readonly family: DatabaseCapabilities['family']
  open(): Promise<DatabaseAdapter>
}
