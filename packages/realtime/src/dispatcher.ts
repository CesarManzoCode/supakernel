import { type Family, type Json, sql } from '@supakernel/contracts'
import type { DatabaseAdapter, FaultPort } from '@supakernel/ports'
import { NULL_FAULT_PORT } from '@supakernel/ports'
import type { OutboxEvent } from './connection.js'
import { outboxTable } from './outbox.js'

export interface DispatcherOptions {
  /** Retention window; GC never removes an event newer than this OR below the min active cursor. */
  readonly retentionMs?: number
  readonly maxRetainedEvents?: number
  /** Fault-injection hook (contract §22). No-op in production. */
  readonly fault?: FaultPort
}

/**
 * Reads `_supakernel.outbox` **after commit** and hands events to the hub in `seq` order
 * (contract §15). Guarantees: total order per project by `seq`; at-least-once within a
 * connection; no exactly-once claim. GC never deletes below the minimum active cursor.
 */
export class OutboxDispatcher {
  private readonly adapter: DatabaseAdapter
  private readonly family: Family
  private readonly opts: Required<Omit<DispatcherOptions, 'fault'>>
  private readonly fault: FaultPort
  private watermark = 0
  private publishEnabled = true

  constructor(adapter: DatabaseAdapter, family: Family, opts: DispatcherOptions = {}) {
    this.adapter = adapter
    this.family = family
    this.fault = opts.fault ?? NULL_FAULT_PORT
    this.opts = {
      retentionMs: opts.retentionMs ?? 24 * 3600_000,
      maxRetainedEvents: opts.maxRetainedEvents ?? 100_000,
    }
  }

  get cursor(): number {
    return this.watermark
  }
  get healthy(): boolean {
    return this.publishEnabled
  }

  private text(t: string): string {
    if (this.family !== 'postgres') return t
    let i = 0
    return t.replace(/\?/g, () => `$${++i}`)
  }

  /** Fetch every event with `seq > cursor`, in order, and advance the cursor past them. */
  async pump(): Promise<OutboxEvent[]> {
    if (!this.publishEnabled) return []
    const rows = await this.adapter.execute(
      sql(
        this.text(
          `SELECT * FROM ${outboxTable(this.family)} WHERE seq > ? ORDER BY seq ASC LIMIT 5000`,
        ),
        [this.watermark],
      ),
    )
    const events: OutboxEvent[] = rows.rows.map((r) => {
      const rec = r as Record<string, unknown>
      return {
        seq: Number(rec.seq),
        schema: String(rec.schema_name),
        table: String(rec.table_name),
        op: String(rec.op) as OutboxEvent['op'],
        pk: parseJson(rec.pk),
        old: parseJson(rec.old_record) as Record<string, Json> | null,
        new: parseJson(rec.new_record) as Record<string, Json> | null,
        commitTs: String(rec.commit_ts),
      }
    })
    if (events.length > 0)
      await this.fault.hit('realtime.after_outbox_commit', { count: String(events.length) })
    const last = events[events.length - 1]
    if (last) {
      await this.fault.hit('realtime.after_send_before_cursor', { seq: String(last.seq) })
      this.watermark = last.seq
    }
    return events
  }

  /** GC events strictly older than the retention window AND at/below every active cursor. */
  async gc(minActiveCursor: number): Promise<number> {
    const boundary = Math.max(0, Math.min(minActiveCursor, this.watermark))
    if (boundary <= 0) return 0
    const cutoffIso = new Date(Date.now() - this.opts.retentionMs).toISOString()
    const res = await this.adapter.execute(
      sql(this.text(`DELETE FROM ${outboxTable(this.family)} WHERE seq <= ? AND commit_ts < ?`), [
        boundary,
        cutoffIso,
      ]),
    )
    return res.rowCount
  }

  /**
   * Health / drift check (contract §15): every managed table must still carry the outbox
   * trigger. A missing trigger disables publish and fails health.
   */
  async checkDrift(managedTables: readonly string[]): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = []
    for (const table of managedTables) {
      const installed = await this.triggerInstalled(table)
      if (!installed) missing.push(table)
    }
    if (missing.length > 0) this.publishEnabled = false
    return { ok: missing.length === 0, missing }
  }

  private async triggerInstalled(table: string): Promise<boolean> {
    if (this.family === 'postgres') {
      const r = await this.adapter.execute(
        sql(`SELECT 1 FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, [
          `sk_outbox_${table}`,
        ]),
      )
      return r.rows.length > 0
    }
    const r = await this.adapter.execute(
      sql(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?`, [
        `sk_outbox_${table}%`,
      ]),
    )
    return r.rows.length >= 3
  }
}

function parseJson(v: unknown): Json {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v as Json
  try {
    return JSON.parse(String(v)) as Json
  } catch {
    return null
  }
}
