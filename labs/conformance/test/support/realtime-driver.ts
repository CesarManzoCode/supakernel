// Test-support wiring: the realtime driver (contract §15, §19.1 — Realtime is nightly).

import type { Json, ScenarioStep } from '@supakernel/contracts'
import type {
  ControlChannel,
  InterpretSession,
  RealtimeDriver,
  StepResult,
  TargetClient,
} from '../../src/index.js'
import { stepInput } from '../../src/index.js'

const SUBSCRIBE_TIMEOUT_MS = 5000
const SETTLE_MS = 1200

export function createRealtimeDriver(): RealtimeDriver {
  // biome-ignore lint/suspicious/noExplicitAny: supabase-js RealtimeChannel handle
  const channels = new Map<string, any>()

  return {
    async subscribe(
      session: InterpretSession,
      targetClient: TargetClient,
      step: ScenarioStep,
      seatKey: string,
    ): Promise<StepResult> {
      const input = stepInput(step)
      const table = String(input.table ?? '')
      const filter = input.filter ? String(input.filter) : undefined
      const client = targetClient.client(seatKey)
      const channel = client.channel(`conf:${table}:${step.id}`)
      const received: Json[] = []
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        // biome-ignore lint/suspicious/noExplicitAny: realtime payload
        (payload: any) => {
          received.push({
            type: payload.eventType ?? payload.type,
            new: payload.new ?? null,
            old: payload.old ?? null,
          })
        },
      )
      session.realtime.events = received
      session.realtime.channel = channel

      const status = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), SUBSCRIBE_TIMEOUT_MS)
        channel.subscribe((s: string) => {
          if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
            clearTimeout(timer)
            resolve(s)
          }
        })
      })
      channels.set(step.id, channel)
      const base: StepResult = {
        step: step.id,
        action: step.action,
        request: { action: step.action, table, filter: filter ?? null },
        status: status === 'SUBSCRIBED' ? 200 : 0,
        headers: {},
        body: { subscribed: status === 'SUBSCRIBED' },
      }
      return status === 'SUBSCRIBED'
        ? base
        : { ...base, unsupported: { code: 'SK_RT_SUBSCRIBE', reason: status } }
    },

    async mutate(control: ControlChannel, step: ScenarioStep): Promise<StepResult> {
      const input = stepInput(step)
      const table = String(input.table ?? '')
      await control.seed(table, (input.rows ?? []) as Parameters<ControlChannel['seed']>[1])
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      return {
        step: step.id,
        action: step.action,
        request: { action: step.action, table },
        status: 200,
        headers: {},
        body: { mutated: Array.isArray(input.rows) ? input.rows.length : 0 },
      }
    },

    async collect(session: InterpretSession, step: ScenarioStep): Promise<StepResult> {
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      const events = session.realtime.events
      for (const channel of channels.values()) {
        try {
          await channel.unsubscribe()
        } catch {
          /* ignore */
        }
      }
      channels.clear()
      return {
        step: step.id,
        action: step.action,
        request: { action: step.action },
        status: 200,
        headers: {},
        body: { events: events as unknown as Json },
      }
    },
  }
}
