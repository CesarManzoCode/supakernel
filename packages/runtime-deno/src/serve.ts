/// <reference path="./deno-serve.d.ts" />
/// <reference lib="dom" />

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

export interface DenoHttpServer {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

/** Bind a Web `fetch` handler (and optional Realtime upgrade) to `Deno.serve` (contract §10 — Deno). */
export function serveDeno(opts: ServeOptions): Promise<DenoHttpServer> {
  const host = opts.host ?? '127.0.0.1'
  return new Promise((resolve) => {
    const server = Deno.serve(
      {
        port: opts.port ?? 0,
        hostname: host,
        onListen: (addr) => {
          resolve({
            url: `http://${host}:${addr.port}`,
            port: addr.port,
            close: () => server.shutdown(),
          })
        },
      },
      (request) => {
        const url = new URL(request.url)
        if (opts.realtime && url.pathname.startsWith(opts.realtime.path)) {
          const { socket, response } = Deno.upgradeWebSocket(request)
          const bridge: RealtimeSocket = {
            send: (data) => socket.send(data),
            close: (code, reason) => socket.close(code, reason),
            onMessage: (cb) =>
              socket.addEventListener('message', (e) => {
                const data = (e as MessageEvent).data
                cb(typeof data === 'string' ? data : new TextDecoder().decode(data))
              }),
            onClose: (cb) => socket.addEventListener('close', () => cb()),
          }
          socket.addEventListener('open', () => opts.realtime?.handle(bridge, request))
          return response
        }
        return opts.fetch(request)
      },
    )
  })
}
