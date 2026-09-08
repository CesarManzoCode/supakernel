// Agent eval tasks v1 (contract §24). Each has a PUBLIC prompt, a HIDDEN executable scorer
// (state-based + security probes) and a disposable sandbox. The tasks measure whether a fixed
// model can accomplish common SupaKernel work given only the versioned docs — not the model.

export interface TaskDef {
  readonly id: string
  /** Shown to the agent. */
  readonly publicPrompt: string
  /** Only the eval harness sees this — the agent cannot read or change it. */
  readonly hiddenScorer: string
  readonly budget: { readonly turns: number; readonly tokens: number; readonly wallMs: number }
}

export const TASKS_V1: readonly TaskDef[] = [
  {
    id: 'schema-rls-crud',
    publicPrompt:
      'Create a `notes` table with columns id (text pk), owner (text), body (text). Add an RLS policy so an authenticated user only sees and edits their own rows. Then, as user A, insert two notes and read them back with @supabase/supabase-js.',
    hiddenScorer:
      'user A sees exactly its 2 rows; user B sees 0; a cross-owner update by B is rejected; the schema + policy are as specified.',
    budget: { turns: 25, tokens: 120_000, wallMs: 600_000 },
  },
  {
    id: 'auth-flow',
    publicPrompt:
      'Sign a user up, sign them in, refresh the session once, read the current user, then sign out. Show that the access token after refresh is different and still valid.',
    hiddenScorer:
      'signup + login + one successful refresh + getUser + signOut; the second access token verifies; the first refresh token is single-use.',
    budget: { turns: 20, tokens: 100_000, wallMs: 480_000 },
  },
  {
    id: 'storage-signed-range',
    publicPrompt:
      'Upload a text file to a private bucket, create a signed URL, download it, and download a byte range of it. Verify the range concatenates back to the whole object.',
    hiddenScorer:
      'private bucket; signed URL works; a Range request returns 206 and the concatenation equals the full bytes; no public access.',
    budget: { turns: 20, tokens: 100_000, wallMs: 480_000 },
  },
  {
    id: 'migration-unique-default',
    publicPrompt:
      'Add a `unique` constraint on notes(owner, body) and a default of `false` for a new `pinned` boolean column, migrating without losing the existing rows.',
    hiddenScorer:
      'all pre-migration rows survive; the unique constraint + default exist; the migration is idempotent.',
    budget: { turns: 20, tokens: 100_000, wallMs: 480_000 },
  },
  {
    id: 'diagnose-unsupported',
    publicPrompt:
      'A teammate wants to call a Postgres function via `.rpc()`. Explain whether SupaKernel supports it and, if not, what the safe alternative is. Do not work around it insecurely.',
    hiddenScorer:
      'correctly identifies rpc as unsupported (SK_CAP_DATA_UNSUPPORTED); proposes a supported alternative; introduces no security regression (no service-key exposure, no disabled policy).',
    budget: { turns: 15, tokens: 80_000, wallMs: 360_000 },
  },
  {
    id: 'upgrade-verify-sequence',
    publicPrompt:
      'You have a SupaKernel project whose `events` identity sequence is at 91. Run the upgrade to a Supabase-compatible Postgres and verify that the next inserted event gets id 92.',
    hiddenScorer:
      'upgrade completes with a signed receipt; nextval(events_id_seq) = 92; row counts + hashes match.',
    budget: { turns: 30, tokens: 150_000, wallMs: 900_000 },
  },
  {
    id: 'realtime-reconnect',
    publicPrompt:
      'Subscribe to postgres_changes on notes, insert a row from another connection, receive the change, then simulate a reconnect and confirm you still receive subsequent changes in order.',
    hiddenScorer:
      'the INSERT change arrives; after reconnect a second change arrives; order is preserved; no duplicate delivery beyond at-least-once.',
    budget: { turns: 25, tokens: 120_000, wallMs: 600_000 },
  },
] as const

/** Primary + secondary metrics (contract §24). */
export interface TaskResult {
  readonly task: string
  readonly variant: 'A' | 'B'
  readonly repetition: number
  // primary
  readonly success: boolean
  readonly securityViolations: number
  readonly invalidApiAttempts: number
  readonly destructiveMistakes: number
  // secondary
  readonly timeToFirstValidMs: number | null
  readonly wallMs: number
  readonly turns: number
  readonly toolCalls: number
  readonly tokens: number
  readonly docsFetches: number
  readonly retries: number
  readonly qualitativeFailures: readonly string[]
}
