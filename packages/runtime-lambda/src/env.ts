/**
 * Configuration the Lambda container receives through the environment (contract §30 L10). The
 * Lambda profile is Data / Auth / Storage / health over PG + S3 — no Realtime, no durable
 * local filesystem.
 */
export interface RuntimeEnv {
  readonly projectRef: string
  readonly serverSecret: string
  readonly databaseUrl: string
  readonly s3: {
    readonly endpoint: string | null
    readonly region: string
    readonly bucket: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly forcePathStyle: boolean
  }
  readonly corsOrigins: readonly string[]
  readonly managementToken: string | null
}

type Source = Record<string, string | undefined>

function req(source: Source, key: string): string {
  const v = source[key]
  if (v === undefined || v === '') throw new Error(`SK_RUNTIME_ENV_MISSING: ${key}`)
  return v
}

export function readRuntimeEnv(source: Source = process.env): RuntimeEnv {
  return {
    projectRef: source.SUPAKERNEL_PROJECT_REF ?? 'local',
    serverSecret: req(source, 'SUPAKERNEL_SERVER_SECRET'),
    databaseUrl: req(source, 'SUPAKERNEL_DATABASE_URL'),
    s3: {
      endpoint: source.SUPAKERNEL_S3_ENDPOINT ?? null,
      region: source.SUPAKERNEL_S3_REGION ?? 'us-east-1',
      bucket: req(source, 'SUPAKERNEL_S3_BUCKET'),
      accessKeyId: req(source, 'SUPAKERNEL_S3_ACCESS_KEY_ID'),
      secretAccessKey: req(source, 'SUPAKERNEL_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: source.SUPAKERNEL_S3_FORCE_PATH_STYLE === 'true',
    },
    corsOrigins: (source.SUPAKERNEL_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    managementToken: source.SUPAKERNEL_MANAGEMENT_TOKEN ?? null,
  }
}
