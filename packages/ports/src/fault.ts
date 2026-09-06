/**
 * Fault-injection port (contract §22). `hit` is a versioned test API: named points where the
 * campaign can force a throw, a delayed error, an adapter error or a hard process exit on the
 * N-th hit. In production every named point is a no-op.
 */
export type FaultName =
  | 'migration.before_step'
  | 'migration.after_effect_before_journal'
  | 'migration.after_journal'
  | 'transaction.before_commit'
  | 'transaction.after_commit_before_response'
  | 'storage.after_reserve'
  | 'storage.after_bytes'
  | 'storage.after_promote'
  | 'storage.before_ready'
  | 'storage.after_ready'
  | 'storage.during_delete'
  | 'auth.after_parent_cas'
  | 'auth.after_child_insert'
  | 'auth.after_commit_before_response'
  | 'upgrade.after_schema'
  | 'upgrade.during_table'
  | 'upgrade.after_data_before_sequence'
  | 'upgrade.during_blob'
  | 'upgrade.before_receipt'
  | 'realtime.after_outbox_commit'
  | 'realtime.before_send'
  | 'realtime.after_send_before_cursor'
  | 'runtime.shutdown_during_request'
  | 'adapter.network_partition'

export interface FaultPort {
  hit(name: FaultName, context?: Readonly<Record<string, string>>): Promise<void>
}

/** The always-safe production implementation. */
export const NULL_FAULT_PORT: FaultPort = {
  hit(): Promise<void> {
    return Promise.resolve()
  },
}
