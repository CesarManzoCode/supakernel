// Minimal ambient declaration for the slice of the `Bun` global the runtime profile uses.
// Avoids a full `@types/bun` dependency (contract §33.1 age gate) while keeping strict types.

interface BunServer {
  readonly port: number
  readonly hostname: string
  stop(closeActiveConnections?: boolean): void
  upgrade(request: Request, options?: { data?: unknown }): boolean
}

interface BunWebSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): number
  close(code?: number, reason?: string): void
  readonly data: unknown
}

interface BunServeOptions {
  port?: number
  hostname?: string
  fetch(request: Request, server: BunServer): Response | Promise<Response>
  websocket?: {
    open?(ws: BunWebSocket): void | Promise<void>
    message?(ws: BunWebSocket, message: string | Uint8Array): void | Promise<void>
    close?(ws: BunWebSocket, code: number, reason: string): void | Promise<void>
  }
}

declare const Bun: {
  serve(options: BunServeOptions): BunServer
  version: string
}
