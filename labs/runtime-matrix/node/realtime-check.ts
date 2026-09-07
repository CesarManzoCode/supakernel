import type { Server } from 'node:http'
import type { Principal } from '@supakernel/contracts'
import type { KernelInstance } from '@supakernel/kernel'
import { decodeFrame, encodeFrame } from '@supakernel/realtime'
import { attachNodeRealtime, type RealtimeSocket } from '@supakernel/runtime-node'
import { WebSocket } from 'ws'

const ANON: Principal = {
  kind: 'anonymous',
  subjectId: null,
  tenantId: 'local',
  role: 'anon',
  sessionId: null,
  claims: {},
  credentialSource: 'none',
}

export interface RealtimeProbeResult {
  readonly ok: boolean
  readonly detail: string
}

/**
 * Drive a real WebSocket (contract §10 — "Node usa `ws@8.21.3`") through the Node realtime
 * upgrade: subscribe to `postgres_changes` on `notes` as an authenticated user, insert a row
 * over HTTP, pump the outbox and assert the change frame arrives on the socket.
 */
export async function probeNodeRealtime(input: {
  kernel: KernelInstance
  server: Server
  httpUrl: string
  publishableKey: string
  accessToken: string
  ownerId: string
}): Promise<RealtimeProbeResult> {
  const conns = new Set<{
    conn: ReturnType<KernelInstance['realtimeConnection']>
    socket: RealtimeSocket
  }>()
  const detach = attachNodeRealtime(input.server, {
    path: '/realtime/v1',
    handle: (socket) => {
      const conn = input.kernel.realtimeConnection(ANON)
      const entry = { conn, socket }
      conns.add(entry)
      socket.onMessage(async (data) => {
        try {
          const out = await conn.handleFrame(decodeFrame(data))
          for (const f of out.frames) socket.send(encodeFrame(f))
          if (out.close) socket.close(out.close.code, out.close.reason)
        } catch {
          /* malformed frame ignored, as the codec contract requires */
        }
      })
      socket.onClose(() => conns.delete(entry))
    },
  })

  const pump = async (): Promise<number> => {
    const events = await input.kernel.dispatcher.pump()
    for (const ev of events) {
      for (const { conn, socket } of conns) {
        const out = conn.deliver(ev)
        for (const f of out.frames) socket.send(encodeFrame(f))
      }
    }
    return events.length
  }

  const wsUrl = `${input.httpUrl.replace('http', 'ws')}/realtime/v1/websocket?apikey=${input.publishableKey}`
  const ws = new WebSocket(wsUrl)
  const received: unknown[] = []
  const done = new Promise<RealtimeProbeResult>((resolve) => {
    const timeout = setTimeout(
      () => resolve({ ok: false, detail: 'no change frame within 5s' }),
      5000,
    )
    ws.on('open', () => {
      ws.send(
        encodeFrame({
          joinRef: '1',
          ref: '1',
          topic: 'realtime:notes',
          event: 'phx_join',
          payload: {
            access_token: input.accessToken,
            config: { postgres_changes: [{ event: '*', schema: 'public', table: 'notes' }] },
          },
        }),
      )
    })
    ws.on('message', (raw) => {
      const frame = decodeFrame(String(raw))
      received.push(frame)
      if (
        frame.event === 'phx_reply' &&
        (frame.payload as { status?: string })?.status === 'error'
      ) {
        clearTimeout(timeout)
        resolve({ ok: false, detail: `join rejected: ${JSON.stringify(frame.payload)}` })
      }
      if (frame.event === 'postgres_changes') {
        clearTimeout(timeout)
        const rec = (frame.payload as { data?: { record?: Record<string, unknown> } })?.data?.record
        resolve(
          rec?.title === 'realtime row'
            ? { ok: true, detail: 'INSERT change frame delivered over ws@8.21.3' }
            : { ok: false, detail: `unexpected change payload: ${JSON.stringify(frame.payload)}` },
        )
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ ok: false, detail: `socket error: ${(err as Error).message}` })
    })
  })

  // let the join settle, then insert + pump a few times
  await new Promise((r) => setTimeout(r, 300))
  await fetch(`${input.httpUrl}/rest/v1/notes`, {
    method: 'POST',
    headers: {
      apikey: input.publishableKey,
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify({
      id: `rt-${Date.now()}`,
      owner_id: input.ownerId,
      title: 'realtime row',
    }),
  })
  for (let i = 0; i < 20; i++) {
    await pump()
    await new Promise((r) => setTimeout(r, 100))
  }

  const result = await done
  ws.close()
  detach()
  return result
}
