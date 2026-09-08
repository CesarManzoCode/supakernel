import type { Json, PolicyRule, Principal, SchemaIR } from '@supakernel/contracts'
import { findColumn, findTable } from '@supakernel/contracts'
import { buildSecurityPlan, evalCheck } from '@supakernel/policy'
import { type ChangeFilter, matchesFilter, parseFilter } from './filter.js'
import { PHX, type PhoenixFrame, reply, systemFrame } from './phoenix-codec.js'

/** Default socket queue bounds (contract §10, §15): 1 MiB / 1024 events → backpressure + close 1013. */
export const QUEUE_MAX_BYTES: number = 1024 * 1024
export const QUEUE_MAX_EVENTS: number = 1024

export interface OutboxEvent {
  readonly seq: number
  readonly schema: string
  readonly table: string
  readonly op: 'INSERT' | 'UPDATE' | 'DELETE'
  readonly pk: Json
  readonly old: Record<string, Json> | null
  readonly new: Record<string, Json> | null
  readonly commitTs: string
}

interface Binding {
  readonly id: number
  readonly event: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
  readonly schema: string
  readonly table: string
  readonly filter: ChangeFilter | null
  readonly rawFilter: string | undefined
  readonly rawEvent: string
  readonly rawTable: string | undefined
}

interface Channel {
  readonly topic: string
  joinRef: string | null
  bindings: Binding[]
  principal: Principal
}

export interface ConnectionConfig {
  readonly schema: SchemaIR
  readonly policies: readonly PolicyRule[]
  readonly issuer: string
  readonly audience: string
  now(): string
  epochMillis(): number
  /** Verify a client access token → the principal it authenticates, or `null`. */
  verifyToken(token: string): Promise<Principal | null>
  /** The principal for the connection's `apikey` (anon / service). */
  readonly anonPrincipal: Principal
  /** Fault-injection hook (contract §22). No-op in production. */
  readonly fault?: import('@supakernel/ports').FaultPort
}

export interface Outgoing {
  readonly frames: readonly PhoenixFrame[]
  /** Set when the connection must be closed (bounded-queue overflow → 1013). */
  readonly close?: { code: number; reason: string }
}

/**
 * The transport-agnostic Realtime connection state machine (contract §15). It consumes decoded
 * Phoenix frames + committed outbox events and produces outgoing frames. It never imports a
 * WebSocket implementation.
 */
export class RealtimeConnection {
  private readonly cfg: ConnectionConfig
  private readonly channels = new Map<string, Channel>()
  private nextBindingId = 1
  private accessToken: string | null
  private tokenPrincipal: Principal
  private tokenExpMs: number | null = null
  private queuedBytes = 0
  private queuedEvents = 0

  constructor(cfg: ConnectionConfig, apikeyPrincipal?: Principal) {
    this.cfg = cfg
    this.accessToken = null
    this.tokenPrincipal = apikeyPrincipal ?? cfg.anonPrincipal
  }

  async handleFrame(frame: PhoenixFrame): Promise<Outgoing> {
    switch (frame.event) {
      case PHX.heartbeat:
        return { frames: [reply(frame, 'ok', {})] }
      case PHX.join:
        return this.onJoin(frame)
      case PHX.leave:
        this.channels.delete(frame.topic)
        return { frames: [reply(frame, 'ok', {})] }
      case PHX.accessToken:
        return this.onAccessToken(frame)
      default:
        return { frames: [reply(frame, 'error', { reason: 'unsupported_event' })] }
    }
  }

  private async onJoin(frame: PhoenixFrame): Promise<Outgoing> {
    const payload = (frame.payload ?? {}) as { config?: Json; access_token?: Json }
    const config = (payload.config ?? {}) as {
      postgres_changes?: Array<{ event?: string; schema?: string; table?: string; filter?: string }>
      broadcast?: Json
      presence?: Json
    }
    const pgc = Array.isArray(config.postgres_changes) ? config.postgres_changes : []
    if (pgc.length === 0) {
      // broadcast / presence only — explicitly unsupported, never a fake ack (contract §15)
      return { frames: [reply(frame, 'error', { reason: 'unsupported_feature' })] }
    }

    if (typeof payload.access_token === 'string') {
      const p = await this.applyToken(payload.access_token)
      if (!p) return { frames: [reply(frame, 'error', { reason: 'token_expired' })] }
    }

    let bindings: Binding[]
    try {
      bindings = pgc.map((b) => ({
        id: this.nextBindingId++,
        event: (b.event ?? '*').toUpperCase() as Binding['event'],
        schema: b.schema ?? 'public',
        table: b.table ?? '*',
        filter: parseFilter(b.filter ?? null),
        rawFilter: b.filter,
        rawEvent: b.event ?? '*',
        rawTable: b.table,
      }))
    } catch {
      return { frames: [reply(frame, 'error', { reason: 'bad_filter' })] }
    }
    for (const b of bindings) {
      if (!['INSERT', 'UPDATE', 'DELETE', '*'].includes(b.event) || b.schema !== 'public') {
        return { frames: [reply(frame, 'error', { reason: 'unsupported_feature' })] }
      }
    }

    this.channels.set(frame.topic, {
      topic: frame.topic,
      joinRef: frame.joinRef,
      bindings,
      principal: this.currentPrincipal(),
    })
    const response = {
      postgres_changes: bindings.map((b) => {
        const entry: Record<string, unknown> = { id: b.id, event: b.rawEvent, schema: b.schema }
        if (b.rawTable !== undefined) entry.table = b.rawTable
        if (b.rawFilter !== undefined) entry.filter = b.rawFilter
        return entry
      }),
    }
    return {
      frames: [reply(frame, 'ok', response as unknown as import('@supakernel/contracts').Json)],
    }
  }

  private async onAccessToken(frame: PhoenixFrame): Promise<Outgoing> {
    const token = (frame.payload as { access_token?: Json })?.access_token
    if (typeof token !== 'string')
      return { frames: [reply(frame, 'error', { reason: 'bad_token' })] }
    const p = await this.applyToken(token)
    if (!p) {
      return {
        frames: [
          systemFrame(frame.topic, 'access token expired'),
          {
            joinRef: frame.joinRef,
            ref: frame.ref,
            topic: frame.topic,
            event: PHX.close,
            payload: {},
          },
        ],
      }
    }
    for (const ch of this.channels.values()) ch.principal = p
    return { frames: [reply(frame, 'ok', {})] }
  }

  private async applyToken(token: string): Promise<Principal | null> {
    const p = await this.cfg.verifyToken(token)
    if (!p) return null
    this.accessToken = token
    this.tokenPrincipal = p
    const claims = p.claims as { exp?: unknown }
    this.tokenExpMs = typeof claims.exp === 'number' ? claims.exp * 1000 : null
    return p
  }

  private currentPrincipal(): Principal {
    return this.accessToken ? this.tokenPrincipal : this.tokenPrincipal
  }

  /** Called on a timer: close channels whose token has expired with no refresh (contract §15). */
  tick(): Outgoing {
    if (
      this.tokenExpMs !== null &&
      this.cfg.epochMillis() >= this.tokenExpMs &&
      this.channels.size > 0
    ) {
      const frames: PhoenixFrame[] = []
      for (const topic of this.channels.keys()) {
        frames.push(systemFrame(topic, 'access token expired'))
        frames.push({ joinRef: null, ref: null, topic, event: PHX.close, payload: {} })
      }
      this.channels.clear()
      return { frames }
    }
    return { frames: [] }
  }

  /** Deliver a committed outbox event to every matching channel (contract §15). */
  deliver(ev: OutboxEvent): Outgoing {
    const frames: PhoenixFrame[] = []
    for (const ch of this.channels.values()) {
      for (const b of ch.bindings) {
        if (b.event !== '*' && b.event !== ev.op) continue
        if (b.table !== '*' && b.table !== ev.table) continue
        if (b.schema !== ev.schema) continue

        const record = ev.op === 'DELETE' ? ev.old : ev.new
        if (!matchesFilter(b.filter, record)) continue

        // re-evaluate row + field policy per event, for THIS channel's principal
        const masked = this.applyPolicy(ch.principal, ev)
        if (!masked.visible) continue

        frames.push({
          joinRef: ch.joinRef,
          ref: null,
          topic: ch.topic,
          event: PHX.postgresChanges,
          payload: {
            ids: [b.id],
            data: {
              schema: ev.schema,
              table: ev.table,
              commit_timestamp: ev.commitTs,
              type: ev.op,
              record: this.canonicalizeRecord(ev.table, masked.new),
              old_record: this.canonicalizeRecord(ev.table, masked.old),
              columns: [],
              errors: null,
            },
          } as unknown as import('@supakernel/contracts').Json,
        })
      }
    }
    if (frames.length === 0) return { frames: [] }

    const bytes = frames.reduce((n, f) => n + JSON.stringify(f).length, 0)
    this.queuedBytes += bytes
    this.queuedEvents += frames.length
    if (this.queuedBytes > QUEUE_MAX_BYTES || this.queuedEvents > QUEUE_MAX_EVENTS) {
      const topic = frames[0]?.topic ?? 'realtime'
      return {
        frames: [systemFrame(topic, 'client queue overflow', { code: 1013 })],
        close: { code: 1013, reason: 'client queue overflow' },
      }
    }
    return { frames }
  }

  /**
   * The change record from the outbox trigger carries the row's *physical* representation
   * (on the SQLite family a `bool` column is 0/1). PostgreSQL's WAL / Supabase Realtime
   * always emits a JSON boolean, so the portable postgres_changes payload must too
   * (contract §9.2, §15).
   */
  private canonicalizeRecord(
    table: string,
    record: Record<string, Json> | null,
  ): Record<string, Json> {
    if (!record) return {}
    const t = findTable(this.cfg.schema, table)
    if (!t) return record
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(record)) {
      const col = findColumn(t, k)
      if (col?.type === 'bool' && typeof v !== 'boolean') {
        if (typeof v === 'number') out[k] = v !== 0
        else if (v === '0' || v === 'false' || v === 'f') out[k] = false
        else if (v === '1' || v === 'true' || v === 't') out[k] = true
        else out[k] = v
      } else {
        out[k] = v
      }
    }
    return out
  }

  /** The consumer acknowledges it has drained N bytes / events from its send buffer. */
  drain(bytes: number, events: number): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes)
    this.queuedEvents = Math.max(0, this.queuedEvents - events)
  }

  private applyPolicy(
    principal: Principal,
    ev: OutboxEvent,
  ): { visible: boolean; new: Record<string, Json> | null; old: Record<string, Json> | null } {
    const plan = buildSecurityPlan(
      { schema: this.cfg.schema, rules: this.cfg.policies, principal, now: this.cfg.now() },
      { table: ev.table, action: 'select' },
    )
    if (plan.decision === 'deny') return { visible: false, new: null, old: null }
    const now = this.cfg.now()
    const rowVisible = (row: Record<string, Json> | null): boolean =>
      row === null || plan.rowUsing === null || evalCheck(plan.rowUsing, row, now)

    // DELETE uses old_record for the visibility decision (contract §15)
    const decisionRow = ev.op === 'DELETE' ? ev.old : ev.new
    if (!rowVisible(decisionRow)) return { visible: false, new: null, old: null }

    const mask = (row: Record<string, Json> | null): Record<string, Json> | null => {
      if (!row) return null
      if (plan.readableFields.size === 0) return {}
      const out: Record<string, Json> = {}
      for (const [k, v] of Object.entries(row)) if (plan.readableFields.has(k)) out[k] = v
      return out
    }
    return { visible: true, new: mask(ev.new), old: mask(ev.old) }
  }

  get channelCount(): number {
    return this.channels.size
  }
}
