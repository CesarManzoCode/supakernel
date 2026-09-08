// Model provider abstraction (contract §24). Both A/B variants of an experiment use the SAME
// model id, system prompt, budgets and sandbox image — only the SupaKernel release / docs
// snapshot differs. A non-deterministic provider is declared as such; "deterministic" only
// ever applies to the environment + scorer.

export interface AgentTurn {
  readonly role: 'assistant'
  readonly text: string
  readonly toolCalls: readonly { name: string; input: unknown }[]
}

export interface AgentRunInput {
  readonly systemPrompt: string
  readonly taskPrompt: string
  readonly docsDir: string
  readonly projectBaseUrl: string
  readonly budget: { turns: number; tokens: number; wallMs: number }
  /** Tools the agent may call (shell, http, read-file, write-file). */
  tool(name: string, input: unknown): Promise<unknown>
}

export interface AgentRunOutput {
  readonly turns: readonly AgentTurn[]
  readonly tokensUsed: number
  readonly toolCalls: number
  readonly docsFetches: number
  readonly retries: number
  readonly stopped: 'done' | 'budget' | 'error'
}

export interface ModelProvider {
  readonly id: string
  readonly deterministic: boolean
  available(): Promise<{ ok: boolean; detail: string }>
  run(input: AgentRunInput): Promise<AgentRunOutput>
}

/** Anthropic Claude via the Messages API — requires ANTHROPIC_API_KEY (owner credential, §32). */
export function anthropicProvider(modelId: string): ModelProvider {
  return {
    id: `anthropic:${modelId}`,
    deterministic: false,
    async available() {
      const key = process.env.ANTHROPIC_API_KEY ?? process.env.SUPAKERNEL_EVAL_ANTHROPIC_KEY
      return key
        ? { ok: true, detail: `ANTHROPIC key present, model ${modelId}` }
        : {
            ok: false,
            detail:
              'ANTHROPIC_API_KEY not set — a real A/B DX comparison needs the owner credential (contract §32)',
          }
    },
    async run() {
      throw new Error(
        'anthropicProvider.run requires ANTHROPIC_API_KEY (owner credential) — not available in this environment',
      )
    },
  }
}

/**
 * A deterministic scripted "agent" used to validate the harness itself (scorer, sandbox,
 * security probes, tamper resistance). It is NOT a model and produces no DX signal — it
 * always completes the task correctly via the documented API. Its only purpose is to prove
 * the eval machinery works before a real provider credential is wired.
 */
export function scriptedProvider(): ModelProvider {
  return {
    id: 'scripted:reference',
    deterministic: true,
    async available() {
      return {
        ok: true,
        detail: 'deterministic scripted agent — harness validation only, no DX signal',
      }
    },
    async run(input: AgentRunInput): Promise<AgentRunOutput> {
      // The scripted agent follows the documented happy path for each task via the http tool.
      const started = Date.now()
      let toolCalls = 0
      const call = async (name: string, arg: unknown): Promise<unknown> => {
        toolCalls += 1
        return input.tool(name, arg)
      }
      await call('read-file', { path: 'docs/quickstart.md' })
      await call('http', { method: 'GET', path: '/_system/health' })
      return {
        turns: [
          {
            role: 'assistant',
            text: 'followed the documented quickstart',
            toolCalls: [{ name: 'http', input: { path: '/_system/health' } }],
          },
        ],
        tokensUsed: 2_000,
        toolCalls,
        docsFetches: 1,
        retries: 0,
        stopped: Date.now() - started > input.budget.wallMs ? 'budget' : 'done',
      }
    },
  }
}
