import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export type WebHandler = (request: Request) => Promise<Response> | Response

export interface ServeOptions {
  readonly fetch: WebHandler
  readonly port?: number
  readonly host?: string
  /** Called once the HTTP server exists, before it starts listening — used to attach upgrades. */
  onServer?(server: Server): void
}

export interface NodeServer {
  readonly url: string
  readonly port: number
  readonly server: Server
  close(): Promise<void>
}

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD'])

function toWebRequest(req: IncomingMessage, origin: string): Request {
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    if (name !== undefined && value !== undefined) headers.append(name, value)
  }
  const url = `${origin}${req.url ?? '/'}`
  if (METHODS_WITHOUT_BODY.has(method)) return new Request(url, { method, headers })
  const body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error — Node requires duplex for a streaming request body
    duplex: 'half',
  })
}

async function writeWebResponse(res: ServerResponse, web: Response): Promise<void> {
  res.statusCode = web.status
  for (const [key, value] of web.headers) res.setHeader(key, value)
  if (!web.body) {
    res.end()
    return
  }
  const nodeStream = Readable.fromWeb(web.body as unknown as Parameters<typeof Readable.fromWeb>[0])
  nodeStream.pipe(res)
  await new Promise<void>((resolve, reject) => {
    nodeStream.on('end', resolve)
    nodeStream.on('error', reject)
    res.on('close', resolve)
  })
}

/** Bind a Web `fetch` handler to a real `node:http` server (contract §10 — Node profile). */
export async function serveNode(opts: ServeOptions): Promise<NodeServer> {
  const host = opts.host ?? '127.0.0.1'
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? `${host}:0`}`
    void (async () => {
      try {
        const web = await opts.fetch(toWebRequest(req, origin))
        await writeWebResponse(res, web)
      } catch (err) {
        if (!res.headersSent) res.statusCode = 500
        res.end(JSON.stringify({ message: 'internal error', code: 'SK_INTERNAL' }))
        void err
      }
    })()
  })
  opts.onServer?.(server)
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://${host}:${port}`,
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
