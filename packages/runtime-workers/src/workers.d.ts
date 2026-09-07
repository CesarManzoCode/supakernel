// Minimal ambient declarations for the slice of the Workers runtime the profile uses, so no
// `@cloudflare/workers-types` dependency is pulled (contract §33.1 age gate).

declare global {
  interface R2Object {
    readonly key: string
    readonly size: number
    readonly etag: string
    readonly uploaded: Date
    readonly checksums: { readonly sha256?: ArrayBuffer }
    readonly customMetadata?: Record<string, string>
    readonly httpMetadata?: { contentType?: string }
  }
  interface R2ObjectBody extends R2Object {
    readonly body: ReadableStream<Uint8Array>
    arrayBuffer(): Promise<ArrayBuffer>
  }
  interface R2Range {
    offset?: number
    length?: number
    suffix?: number
  }
  interface R2PutOptions {
    customMetadata?: Record<string, string>
    httpMetadata?: { contentType?: string }
    sha256?: string
  }
  interface R2GetOptions {
    range?: R2Range
  }
  interface R2Objects {
    objects: R2Object[]
    truncated: boolean
    cursor?: string
  }
  interface R2Bucket {
    put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
      options?: R2PutOptions,
    ): Promise<R2Object>
    get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>
    head(key: string): Promise<R2Object | null>
    delete(key: string | string[]): Promise<void>
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>
  }

  interface D1Database {
    prepare(sql: string): unknown
    batch(statements: unknown[]): Promise<unknown[]>
    exec(sql: string): Promise<{ count: number; duration: number }>
  }

  class WebSocketPair {
    0: WebSocket
    1: WebSocket
  }
  interface WebSocket {
    accept(): void
  }
  interface ResponseInit {
    webSocket?: WebSocket | null
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void
    passThroughOnException(): void
  }
}

export {}
