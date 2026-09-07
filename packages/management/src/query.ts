import { type DbResult, type KernelError, kernelError, sql } from '@supakernel/contracts'
import type { DatabaseAdapter } from '@supakernel/ports'

export class ManagementError extends Error {
  readonly kernelError: KernelError
  constructor(ke: KernelError) {
    super(`${ke.code}: ${ke.message}`)
    this.name = 'ManagementError'
    this.kernelError = ke
  }
}

function bad(code: string, message: string, status = 400): ManagementError {
  return new ManagementError(
    kernelError({ category: 'capability', code, message, httpStatus: status, retryable: false }),
  )
}

const READ_ONLY_PREFIX = /^\s*(select|with|explain|show|table)\b/i
const WRITE_OR_DDL =
  /\b(insert|update|delete|merge|create|drop|alter|truncate|grant|revoke|comment|copy|vacuum|reindex|cluster|call|do)\b/i
const DANGEROUS =
  /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|pg_file_write|pg_execute_server_program|copy\s+.*\s+(from|to)\s+program)\b/i

export interface ManagementQueryOptions {
  readonly readOnly: boolean
  readonly timeoutMs: number
}

/**
 * Validate a `database/query` request (contract §16): one statement only, a `SELECT` allowlist
 * when `read_only`, no filesystem / network extension functions, and a hard statement timeout.
 */
export function validateManagementQuery(raw: string, options: ManagementQueryOptions): string {
  const statements = splitStatements(raw)
  if (statements.length === 0) throw bad('SK_MGMT_QUERY_EMPTY', 'query is empty')
  if (statements.length > 1) throw bad('SK_MGMT_QUERY_MULTI', 'only a single statement is allowed')
  const stmt = statements[0] as string
  if (DANGEROUS.test(stmt))
    throw bad('SK_MGMT_QUERY_FORBIDDEN', 'filesystem / network functions are not allowed', 403)
  if (options.readOnly) {
    if (!READ_ONLY_PREFIX.test(stmt) || WRITE_OR_DDL.test(stmt)) {
      throw bad('SK_MGMT_QUERY_NOT_READ_ONLY', 'read_only queries must be a single SELECT', 403)
    }
  }
  return stmt
}

export async function executeManagementQuery(
  adapter: DatabaseAdapter,
  raw: string,
  options: ManagementQueryOptions,
): Promise<DbResult> {
  const stmt = validateManagementQuery(raw, options)
  const family = adapter.capabilities.family
  return adapter.transaction(
    { isolation: 'read-committed', readOnly: options.readOnly },
    async (tx) => {
      if (family === 'postgres') {
        await tx.execute(
          sql(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`),
        )
      }
      return tx.execute(sql(stmt))
    },
  )
}

function splitStatements(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let inS = false
  let inD = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    if (c === ';' && !inS && !inD) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
