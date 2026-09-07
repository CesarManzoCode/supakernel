// Minimal ambient declaration for the slice of the `Deno` global the runtime profile uses.
// Avoids depending on the full Deno lib types (contract §33.1) while keeping strict types.

interface DenoServer {
  readonly addr: { readonly hostname: string; readonly port: number }
  shutdown(): Promise<void>
  finished: Promise<void>
}

interface DenoServeOptions {
  port?: number
  hostname?: string
  onListen?(addr: { hostname: string; port: number }): void
}

interface DenoWebSocketUpgrade {
  readonly socket: WebSocket
  readonly response: Response
}

declare const Deno: {
  serve(
    options: DenoServeOptions,
    handler: (request: Request) => Response | Promise<Response>,
  ): DenoServer
  upgradeWebSocket(request: Request): DenoWebSocketUpgrade
  env: { get(key: string): string | undefined; toObject(): Record<string, string> }
  readonly version: { readonly deno: string }
}
