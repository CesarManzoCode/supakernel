// SupaKernel Management — allowlisted §16 subset + /_system + MCP (contract §16, §30 L9).
// Imports contracts / ports / schema only. No Hono.

export { buildCapabilities, type CapabilityInput } from './capabilities.js'
export { createMcpServer, MCP_ALLOWED_TOOLS, type McpDeps } from './mcp.js'
export { applyMigration, ensureMigrationTable, listMigrations } from './migrations.js'
export { MANAGEMENT_OPENAPI } from './openapi.js'
export {
  executeManagementQuery,
  ManagementError,
  type ManagementQueryOptions,
  validateManagementQuery,
} from './query.js'
export {
  createManagementHandler,
  type ManagementDeps,
  type ManagementProject,
} from './routes.js'
export { generateTypescriptTypes } from './types.js'
