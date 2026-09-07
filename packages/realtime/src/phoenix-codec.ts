import type { Json } from '@supakernel/contracts'

/**
 * The Phoenix v2 array codec used by `@supabase/realtime-js` (contract §15):
 *
 *   [joinRef, ref, topic, event, payload]
 *
 * `joinRef` / `ref` are `null` for server-initiated frames. This module is transport-agnostic —
 * it never imports a WebSocket implementation.
 */
export interface PhoenixFrame {
  readonly joinRef: string | null
  readonly ref: string | null
  readonly topic: string
  readonly event: string
  readonly payload: Json
}

export const PHX = {
  join: 'phx_join',
  leave: 'phx_leave',
  reply: 'phx_reply',
  error: 'phx_error',
  close: 'phx_close',
  heartbeat: 'heartbeat',
  accessToken: 'access_token',
  system: 'system',
  postgresChanges: 'postgres_changes',
} as const

export function decodeFrame(raw: string): PhoenixFrame {
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    throw new Error('SK_RT_MALFORMED_FRAME')
  }
  if (!Array.isArray(arr) || arr.length !== 5) throw new Error('SK_RT_MALFORMED_FRAME')
  const [joinRef, ref, topic, event, payload] = arr as [unknown, unknown, unknown, unknown, unknown]
  if (typeof topic !== 'string' || typeof event !== 'string')
    throw new Error('SK_RT_MALFORMED_FRAME')
  return {
    joinRef: joinRef === null || joinRef === undefined ? null : String(joinRef),
    ref: ref === null || ref === undefined ? null : String(ref),
    topic,
    event,
    payload: (payload ?? null) as Json,
  }
}

export function encodeFrame(f: PhoenixFrame): string {
  return JSON.stringify([f.joinRef, f.ref, f.topic, f.event, f.payload])
}

export function reply(to: PhoenixFrame, status: 'ok' | 'error', response: Json): PhoenixFrame {
  return {
    joinRef: to.joinRef,
    ref: to.ref,
    topic: to.topic,
    event: PHX.reply,
    payload: { status, response },
  }
}

export function systemFrame(
  topic: string,
  message: string,
  extra: Record<string, Json> = {},
): PhoenixFrame {
  return {
    joinRef: null,
    ref: null,
    topic,
    event: PHX.system,
    payload: { status: 'error', extension: 'system', message, ...extra },
  }
}
