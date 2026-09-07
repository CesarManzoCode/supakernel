/// <reference path="./bun-serve.d.ts" />

export type WebHandler = (request: Request) => Promise<Response> | Response

export interface RealtimeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
}

export interface ServeOptions {
  readonly fetch: WebHandler
  readonly port?: number
  readonly host?: string
  readonly realtime?: {
    readonly path: string
    handle(socket: RealtimeSocket, request: Request): void
  }
}

export interface BunHttpServer {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

interface SocketState {
  onMessage?: (data: string) => void
  onClose?: () => void
  outbound: BunWebSocket | null
}

/** Bind a Web `fetch` handler (and optional Realtime upgrade) to `Bun.serve` (contract §10 — Bun). */
export function serveBun(opts: ServeOptions): BunHttpServer {
  const host = opts.host ?? '127.0.0.1'
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: host,
    fetch: (request, srv) => {
      const url = new URL(request.url)
      if (opts.realtime && url.pathname.startsWith(opts.realtime.path)) {
        const state: SocketState = { outbound: null }
        const bridge: RealtimeSocket = {
          send: (data) => state.outbound?.send(data),
          close: (code, reason) => state.outbound?.close(code, reason),
          onMessage: (cb) => {
            state.onMessage = cb
          },
          onClose: (cb) => {
            state.onClose = cb
          },
        }
        if (srv.upgrade(request, { data: { state, bridge, request } })) {
          return new Response(null, { status: 101 })
        }
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      return opts.fetch(request)
    },
    websocket: {
      open: (ws) => {
        const { state, bridge, request } = ws.data as {
          state: SocketState
          bridge: RealtimeSocket
          request: Request
        }
        state.outbound = ws
        opts.realtime?.handle(bridge, request)
      },
      message: (ws, message) => {
        const { state } = ws.data as { state: SocketState }
        state.onMessage?.(typeof message === 'string' ? message : new TextDecoder().decode(message))
      },
      close: (ws) => {
        const { state } = ws.data as { state: SocketState }
        state.onClose?.()
      },
    },
  })
  return {
    url: `http://${host}:${server.port}`,
    port: server.port,
    close: () => {
      server.stop(true)
      return Promise.resolve()
    },
  }
}
