import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'

/**
 * A transport-neutral realtime socket. The Realtime codec + connection live in
 * `@supakernel/realtime`; this only carries text frames in and out (contract §10 — Node uses
 * `ws@8.21.3`).
 */
export interface RealtimeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
}

export interface AttachRealtimeOptions {
  readonly path: string
  handle(socket: RealtimeSocket, request: { url: string; headers: Record<string, string> }): void
}

/** Attach a WebSocket upgrade listener for the Realtime endpoint to a running Node server. */
export function attachNodeRealtime(server: Server, opts: AttachRealtimeOptions): () => void {
  const wss = new WebSocketServer({ noServer: true })

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = req.url ?? '/'
    if (!url.startsWith(opts.path)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge: RealtimeSocket = {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        onMessage: (cb) => ws.on('message', (raw) => cb(raw.toString())),
        onClose: (cb) => ws.on('close', cb),
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v
      }
      opts.handle(bridge, { url: `http://${req.headers.host ?? 'localhost'}${url}`, headers })
    })
  }

  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
    wss.close()
  }
}
