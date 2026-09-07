/// <reference path="./workers.d.ts" />

export interface RealtimeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
}

export interface RealtimeUpgrade {
  readonly response: Response
  readonly socket: RealtimeSocket
}

/**
 * Perform a `WebSocketPair` upgrade for the Realtime endpoint (contract §10 — Workers use
 * `WebSocketPair`, never a faked socket). The caller wires the returned `socket` to a
 * `RealtimeConnection` from `@supakernel/realtime`.
 */
export function upgradeWorkersRealtime(): RealtimeUpgrade {
  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1] as WebSocket & {
    send(data: string): void
    close(code?: number, reason?: string): void
    addEventListener(type: string, cb: (event: MessageEvent | CloseEvent) => void): void
  }
  server.accept()
  const socket: RealtimeSocket = {
    send: (data) => server.send(data),
    close: (code, reason) => server.close(code, reason),
    onMessage: (cb) =>
      server.addEventListener('message', (event) => {
        const data = (event as MessageEvent).data
        cb(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer))
      }),
    onClose: (cb) => server.addEventListener('close', () => cb()),
  }
  return { response: new Response(null, { status: 101, webSocket: client }), socket }
}
