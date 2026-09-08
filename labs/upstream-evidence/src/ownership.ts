// Ownership classifier (contract §28). An explainable repo/path/maintainer score — never an
// automatic @-mention. Candidates are the natural set from §28.

export interface OwnershipCandidate {
  readonly repo: string
  readonly path: string
  /** 0-1: how confident that this repo/path owns the behaviour. */
  readonly score: number
  readonly rationale: string
  readonly maintainersHint: string
  readonly contributing: string
}

export interface OwnershipInput {
  readonly capability: 'data' | 'auth' | 'storage' | 'realtime' | 'cli' | 'benchmark'
  /** The upstream symbol(s) the reference trace / source search implicated. */
  readonly symbols: readonly string[]
  /** Where the divergence was actually observed (which vendor component). */
  readonly observedIn: string
}

const CANDIDATE_TABLE: Record<string, Omit<OwnershipCandidate, 'score' | 'rationale'>> = {
  storage: {
    repo: 'supabase/storage',
    path: 'src/http/routes/object/',
    maintainersHint: 'supabase/storage maintainers (see CODEOWNERS)',
    contributing: 'https://github.com/supabase/storage/blob/master/CONTRIBUTING.md',
  },
  data: {
    repo: 'PostgREST/postgrest',
    path: 'src/PostgREST/',
    maintainersHint: 'PostgREST core team',
    contributing: 'https://postgrest.org/en/stable/contributing.html',
  },
  auth: {
    repo: 'supabase/auth',
    path: 'internal/api/',
    maintainersHint: 'supabase/auth maintainers',
    contributing: 'https://github.com/supabase/auth/blob/master/CONTRIBUTING.md',
  },
  realtime: {
    repo: 'supabase/realtime',
    path: 'lib/realtime/',
    maintainersHint: 'supabase/realtime maintainers',
    contributing: 'https://github.com/supabase/realtime/blob/main/CONTRIBUTING.md',
  },
  cli: {
    repo: 'supabase/cli',
    path: 'internal/',
    maintainersHint: 'supabase/cli maintainers',
    contributing: 'https://github.com/supabase/cli/blob/main/CONTRIBUTING.md',
  },
  benchmark: {
    repo: 'bknd-io/bknd',
    path: 'app/src/',
    maintainersHint: 'Dennis Senn (bknd author)',
    contributing: 'https://github.com/bknd-io/bknd',
  },
}

export function classifyOwnership(input: OwnershipInput): OwnershipCandidate {
  const base = CANDIDATE_TABLE[input.capability]
  if (!base) {
    return {
      repo: 'unknown',
      path: '',
      score: 0,
      rationale: `no candidate repo mapped for capability ${input.capability}`,
      maintainersHint: '',
      contributing: '',
    }
  }
  // score: symbol overlap with the observed component + the vendor component match
  const componentMatch = input.observedIn.toLowerCase().includes(base.repo.split('/')[1] ?? '')
  const symbolSignal = input.symbols.length > 0 ? 0.5 : 0.2
  const score = Math.min(1, symbolSignal + (componentMatch ? 0.4 : 0.1))
  return {
    ...base,
    score,
    rationale: `capability=${input.capability}; observed in ${input.observedIn}; implicated symbols: ${input.symbols.join(', ') || 'none identified'}. Component match: ${componentMatch}.`,
  }
}
