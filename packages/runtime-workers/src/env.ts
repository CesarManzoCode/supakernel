/**
 * The binding object a Worker receives as its second `fetch` argument (contract §30 L10). The
 * Workers profile is Data / Auth / Storage / Realtime + health over D1 + R2 — no filesystem,
 * no SMTP, no raw-SQL Management.
 */
export interface WorkersEnv {
  readonly DB: D1Database
  readonly BUCKET: R2Bucket
  readonly SUPAKERNEL_PROJECT_REF?: string
  readonly SUPAKERNEL_SERVER_SECRET?: string
  readonly SUPAKERNEL_CORS_ORIGINS?: string
  readonly SUPAKERNEL_MANAGEMENT_TOKEN?: string
  /** The portable-core hash, computed at bundle time (a Worker cannot read the source itself). */
  readonly SUPAKERNEL_CORE_HASH?: string
}

export interface WorkersConfig {
  readonly projectRef: string
  readonly serverSecret: string
  readonly corsOrigins: readonly string[]
  readonly managementToken: string | null
  readonly coreHash: string | null
}

export function readWorkersConfig(env: WorkersEnv): WorkersConfig {
  return {
    projectRef: env.SUPAKERNEL_PROJECT_REF ?? 'local',
    serverSecret: env.SUPAKERNEL_SERVER_SECRET ?? 'dev-insecure-secret',
    corsOrigins: (env.SUPAKERNEL_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    managementToken: env.SUPAKERNEL_MANAGEMENT_TOKEN ?? null,
    coreHash: env.SUPAKERNEL_CORE_HASH ?? null,
  }
}
