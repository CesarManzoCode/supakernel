/** Configuration a Node host supplies through the environment (contract §30 L10). */
export interface RuntimeEnv {
  readonly projectRef: string
  readonly serverSecret: string
  /** `postgres://…` for the PG profile; `null` selects an embedded SQLite/PGlite adapter. */
  readonly databaseUrl: string | null
  /** Filesystem root for the FS blob adapter; `null` selects S3. */
  readonly blobRoot: string | null
  readonly s3: S3Env | null
  readonly port: number
  readonly host: string
  readonly corsOrigins: readonly string[]
  readonly managementToken: string | null
  readonly managementQueryEnabled: boolean
}

export interface S3Env {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly forcePathStyle: boolean
}

type Source = Record<string, string | undefined>

function req(source: Source, key: string, fallback?: string): string {
  const v = source[key] ?? fallback
  if (v === undefined || v === '') throw new Error(`SK_RUNTIME_ENV_MISSING: ${key}`)
  return v
}

/** Parse `SUPAKERNEL_*` variables into a typed config. Throws `SK_RUNTIME_ENV_MISSING` on gaps. */
export function readRuntimeEnv(source: Source = process.env): RuntimeEnv {
  const s3Endpoint = source.SUPAKERNEL_S3_ENDPOINT
  const s3: S3Env | null = s3Endpoint
    ? {
        endpoint: s3Endpoint,
        region: source.SUPAKERNEL_S3_REGION ?? 'us-east-1',
        bucket: req(source, 'SUPAKERNEL_S3_BUCKET'),
        accessKeyId: req(source, 'SUPAKERNEL_S3_ACCESS_KEY_ID'),
        secretAccessKey: req(source, 'SUPAKERNEL_S3_SECRET_ACCESS_KEY'),
        forcePathStyle: source.SUPAKERNEL_S3_FORCE_PATH_STYLE !== 'false',
      }
    : null
  return {
    projectRef: req(source, 'SUPAKERNEL_PROJECT_REF', 'local'),
    serverSecret: req(source, 'SUPAKERNEL_SERVER_SECRET', 'dev-insecure-secret'),
    databaseUrl: source.SUPAKERNEL_DATABASE_URL ?? null,
    blobRoot: source.SUPAKERNEL_BLOB_ROOT ?? null,
    s3,
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
