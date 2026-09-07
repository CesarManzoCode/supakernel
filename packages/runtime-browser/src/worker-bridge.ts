import { decodeRequest, encodeResponse, type WireMessage } from './protocol.js'

export type WebHandler = (request: Request) => Promise<Response> | Response

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * Worker-side half of the browser bridge (contract §10). Runs inside the SupaKernel WebWorker:
 * decodes each page request, runs the composed gateway handler and posts the response back.
 * Call once the kernel is composed; it announces readiness to the page.
 */
export function serveInWorker(
  scope: WorkerScope,
  handler: WebHandler,
  meta?: Record<string, unknown>,
): void {
  scope.addEventListener('message', (event) => {
    const msg = event.data as WireMessage
    if (msg.kind !== 'sk-request') return
    void (async () => {
      try {
        const response = await handler(decodeRequest(msg))
        const wire = await encodeResponse(msg.id, response)
        scope.postMessage(wire, wire.body ? [wire.body] : [])
      } catch (err) {
        scope.postMessage({
          kind: 'sk-response',
          id: msg.id,
          status: 500,
          headers: [],
          body: null,
          error: (err as Error).message ?? String(err),
        })
      }
    })()
  })
  scope.postMessage(meta ? { kind: 'sk-ready', meta } : { kind: 'sk-ready' })
}
