/** Configuration a Bun host supplies through the environment (contract §30 L10). */
export interface RuntimeEnv {
  readonly projectRef: string
  readonly serverSecret: string
  readonly databaseUrl: string | null
  readonly blobRoot: string | null
  readonly port: number
  readonly host: string
  readonly corsOrigins: readonly string[]
  readonly managementToken: string | null
  readonly managementQueryEnabled: boolean
}

type Source = Record<string, string | undefined>

/** Parse `SUPAKERNEL_*` variables. Bun exposes `process.env`, so no Bun-specific API is needed. */
export function readRuntimeEnv(source: Source): RuntimeEnv {
  return {
    projectRef: source.SUPAKERNEL_PROJECT_REF ?? 'local',
    serverSecret: source.SUPAKERNEL_SERVER_SECRET ?? 'dev-insecure-secret',
    databaseUrl: source.SUPAKERNEL_DATABASE_URL ?? null,
    blobRoot: source.SUPAKERNEL_BLOB_ROOT ?? null,
    port: Number(source.SUPAKERNEL_PORT ?? '8787'),
    host: source.SUPAKERNEL_HOST ?? '127.0.0.1',
    corsOrigins: (source.SUPAKERNEL_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    managementToken: source.SUPAKERNEL_MANAGEMENT_TOKEN ?? null,
    managementQueryEnabled: source.SUPAKERNEL_MANAGEMENT_QUERY === 'true',
  }
}
