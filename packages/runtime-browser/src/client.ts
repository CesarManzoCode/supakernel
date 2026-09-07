import { decodeResponse, encodeRequest, type WireMessage } from './protocol.js'

export interface BrowserClient {
  /** A `fetch` implementation to hand to `@supabase/supabase-js`'s `global.fetch`. */
  readonly fetch: typeof fetch
  /** Resolves once the worker has reported it is ready to serve, with any bootstrap metadata. */
  ready(): Promise<Record<string, unknown>>
  dispose(): void
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  terminate?(): void
}

/**
 * Bridge page-side `fetch(url, init)` calls to a SupaKernel WebWorker over `postMessage`
 * (contract §10). The worker owns the database, the blob store and every service; the page
 * only ships requests and receives responses.
 */
export function createBrowserClient(worker: WorkerLike): BrowserClient {
  let nextId = 1
  const pending = new Map<number, (msg: Extract<WireMessage, { kind: 'sk-response' }>) => void>()
  let readyResolve: ((meta: Record<string, unknown>) => void) | null = null
  const readyPromise = new Promise<Record<string, unknown>>((resolve) => {
    readyResolve = resolve
  })

  const onMessage = (event: MessageEvent): void => {
    const msg = event.data as WireMessage
    if (msg.kind === 'sk-ready') {
      readyResolve?.(msg.meta ?? {})
      return
    }
    if (msg.kind === 'sk-response') {
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  }
  worker.addEventListener('message', onMessage)

  const bridgedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request && !init
        ? input
        : new Request(
            typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
            init,
          )
    const id = nextId++
    const wire = await encodeRequest(id, request)
    const result = await new Promise<Extract<WireMessage, { kind: 'sk-response' }>>((resolve) => {
      pending.set(id, resolve)
      worker.postMessage(wire, wire.body ? [wire.body] : [])
    })
    return decodeResponse(result)
  }) as typeof fetch

  return {
    fetch: bridgedFetch,
    ready: () => readyPromise,
    dispose: () => {
      worker.removeEventListener('message', onMessage)
      worker.terminate?.()
    },
  }
}
