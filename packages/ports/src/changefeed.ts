import type { Json } from '@supakernel/contracts'

/**
 * Change-capture port (contract §15). The schema layer installs managed triggers that write
 * `_supakernel.outbox` in the same transaction as the row; the dispatcher reads after commit.
 */
export interface OutboxEvent {
  readonly sequence: bigint
  readonly schema: string
  readonly table: string
  readonly op: 'INSERT' | 'UPDATE' | 'DELETE'
  readonly primaryKey: Readonly<Record<string, Json>>
  readonly oldRecord: Readonly<Record<string, Json>> | null
  readonly newRecord: Readonly<Record<string, Json>> | null
  readonly committedAt: string
}

export interface ChangefeedPort {
  /** Events strictly after `afterSequence`, in total project order. */
  read(afterSequence: bigint, limit: number): Promise<readonly OutboxEvent[]>
  /** Advance a dispatcher watermark; GC never deletes before the minimum active cursor. */
  acknowledge(dispatcherId: string, sequence: bigint): Promise<void>
}
