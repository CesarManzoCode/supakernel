/**
 * Configuration a Deno host supplies through the environment (contract §30 L10). The Deno
 * profile is Data / Auth / Storage / Realtime / Management **read-only** — no mutating
 * Management SQL, no SMTP — so it carries no mail settings.
 */
export interface RuntimeEnv {
  readonly projectRef: string
  readonly serverSecret: string
  readonly databaseUrl: string | null
  readonly blobRoot: string | null
  readonly port: number
  readonly host: string
  readonly corsOrigins: readonly string[]
  readonly managementToken: string | null
}

type Source = Record<string, string | undefined>

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
  }
}
