import type { Json } from '@supakernel/contracts'

/**
 * A minimal real MCP server (JSON-RPC 2.0) over the Management subset (contract §16). Exposes
 * only the allowlisted tools; any other tool name returns a clear `unsupported` error rather
 * than a generic failure.
 */
export interface McpDeps {
  /** The Management fetch handler; MCP tools call it with a Management-audience token. */
  handler(request: Request): Promise<Response>
  readonly managementToken: string
  readonly baseUrl: string
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: Json
}
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: Json
  error?: { code: number; message: string; data?: Json }
}

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List the SupaKernel projects.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project',
    description: 'Get one project by ref.',
    inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
  },
  {
    name: 'execute_sql',
    description: 'Run a single SQL statement against a project database (read_only defaults true).',
    inputSchema: {
      type: 'object',
      required: ['project_ref', 'query'],
      properties: {
        project_ref: { type: 'string' },
        query: { type: 'string' },
        read_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'list_migrations',
    description: 'List applied migrations for a project.',
    inputSchema: {
      type: 'object',
      required: ['project_ref'],
      properties: { project_ref: { type: 'string' } },
    },
  },
  {
    name: 'apply_migration',
    description: 'Apply a named migration (single statement) to a project.',
    inputSchema: {
      type: 'object',
      required: ['project_ref', 'name', 'query'],
      properties: {
        project_ref: { type: 'string' },
        name: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'generate_typescript_types',
    description: 'Generate the Database TypeScript type from a project schema.',
    inputSchema: {
      type: 'object',
      required: ['project_ref'],
      properties: { project_ref: { type: 'string' } },
    },
  },
] as const

export const MCP_ALLOWED_TOOLS: readonly string[] = TOOLS.map((t) => t.name)

export function createMcpServer(deps: McpDeps): {
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse>
} {
  const call = async (path: string, method: string, body?: Json): Promise<Response> =>
    deps.handler(
      new Request(`${deps.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${deps.managementToken}`,
          'content-type': 'application/json',
          'x-sk-peer': 'loopback',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  async function runTool(name: string, args: Record<string, Json>): Promise<Json> {
    switch (name) {
      case 'list_projects':
        return jsonBody(await call('/v1/projects', 'GET'))
      case 'get_project':
        return jsonBody(await call(`/v1/projects/${String(args.ref)}`, 'GET'))
      case 'execute_sql':
        return jsonBody(
          await call(`/v1/projects/${String(args.project_ref)}/database/query`, 'POST', {
            query: String(args.query),
            read_only: args.read_only !== false,
          }),
        )
      case 'list_migrations':
        return jsonBody(
          await call(`/v1/projects/${String(args.project_ref)}/database/migrations`, 'GET'),
        )
      case 'apply_migration':
        return jsonBody(
          await call(`/v1/projects/${String(args.project_ref)}/database/migrations`, 'POST', {
            name: String(args.name),
            query: String(args.query),
          }),
        )
      case 'generate_typescript_types':
        return jsonBody(
          await call(`/v1/projects/${String(args.project_ref)}/types/typescript`, 'GET'),
        )
      default:
        throw new McpUnsupported(name)
    }
  }

  return {
    async handle(message: JsonRpcRequest): Promise<JsonRpcResponse> {
      const id = message.id ?? null
      try {
        if (message.method === 'initialize') {
          return ok(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'supakernel-management', version: '1.0.0' },
          })
        }
        if (message.method === 'tools/list') {
          return ok(id, { tools: TOOLS as unknown as Json })
        }
        if (message.method === 'tools/call') {
          const params = (message.params ?? {}) as {
            name?: string
            arguments?: Record<string, Json>
          }
          const name = params.name ?? ''
          if (!MCP_ALLOWED_TOOLS.includes(name)) throw new McpUnsupported(name)
          const result = await runTool(name, params.arguments ?? {})
          return ok(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: false,
          })
        }
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        }
      } catch (err) {
        if (err instanceof McpUnsupported) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `unsupported tool: ${err.tool} (outside the SupaKernel Management subset, contract §16)`,
            },
          }
        }
        return { jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } }
      }
    },
  }
}

class McpUnsupported extends Error {
  readonly tool: string
  constructor(tool: string) {
    super(`unsupported tool: ${tool}`)
    this.tool = tool
  }
}

function ok(id: string | number | null, result: Json): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}
async function jsonBody(res: Response): Promise<Json> {
  const text = await res.text()
  try {
    return JSON.parse(text) as Json
  } catch {
    return { raw: text }
  }
}
