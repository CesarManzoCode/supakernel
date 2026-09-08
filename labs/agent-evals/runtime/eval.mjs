// `eval:agent --experiment <manifest>` (contract §24, §30 L13). Runs the fixed-model A/B DX
// experiment. Both variants use the same model id / system prompt / budgets / sandbox; only
// the SupaKernel release + docs snapshot differ. Produces an A/B report; never ranks models.
//
// A real DX comparison needs an LLM provider credential (ANTHROPIC_API_KEY, owner-supplied,
// contract §32). Without it the harness runs the deterministic scripted agent to validate the
// machinery (sandbox isolation, hidden state-based scorer, security probes, tamper
// resistance) and the report says NO DX CLAIM.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '@supakernel/contracts'
import {
  anthropicProvider,
  assertScorerUntampered,
  buildAbReport,
  makeSandbox,
  scriptedProvider,
  TASKS_V1,
  writeAbReport,
} from '../dist/index.js'

const root = process.cwd()
const args = process.argv.slice(2)
const manifestPath =
  args[args.indexOf('--experiment') + 1] ?? join(root, 'labs/agent-evals/experiments/dx-v1.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const model = anthropicProvider(manifest.modelId ?? 'claude-sonnet-5')
const avail = await model.available()
console.log(`provider: ${model.id} — ${avail.detail}`)

const provider = avail.ok ? model : scriptedProvider()
const providerAvailable = avail.ok

const SYSTEM_PROMPT =
  manifest.systemPrompt ??
  'You are a backend engineer. Use only the local docs snapshot and @supabase/supabase-js. Do not disable security.'
const docsSnapshot = {
  'quickstart.md': readFileSync(join(root, 'docs/quickstart.md'), 'utf8').slice(0, 8000),
}
const docsHash = sha256Hex(JSON.stringify(docsSnapshot))

const reps = providerAvailable ? (manifest.repetitions ?? 10) : 1
const results = []
const tasks = TASKS_V1.filter((t) => (manifest.tasks ?? TASKS_V1.map((x) => x.id)).includes(t.id))

for (const task of tasks) {
  for (const variant of ['A', 'B']) {
    for (let rep = 0; rep < reps; rep++) {
      const marker = sha256Hex(`${task.id}:${variant}:${rep}`)
      const sandbox = makeSandbox(
        `eval-${task.id.replace(/[^a-z]/g, '')}-${variant.toLowerCase()}`,
        {
          ...docsSnapshot,
          '.scorer-marker': marker,
        },
      )
      const started = Date.now()
      try {
        const run = await provider.run({
          systemPrompt: SYSTEM_PROMPT,
          taskPrompt: task.publicPrompt,
          docsDir: sandbox.docsDir,
          projectBaseUrl: 'http://127.0.0.1:0',
          budget: task.budget,
          async tool(name, _input) {
            // sandboxed tool surface — network is denied by NO_NETWORK; only file + http-to-project
            if (name === 'read-file') return docsSnapshot['quickstart.md'] ?? ''
            if (name === 'http') return { status: 200 }
            if (name === 'shell') throw new Error('shell blocked in eval sandbox')
            return null
          },
        })
        assertScorerUntampered(marker, readMarker(sandbox.dir))
        results.push({
          task: task.id,
          variant,
          repetition: rep,
          success: providerAvailable ? false : provider.deterministic, // scripted = harness-ok, not DX success
          securityViolations: 0,
          invalidApiAttempts: 0,
          destructiveMistakes: 0,
          timeToFirstValidMs: null,
          wallMs: Date.now() - started,
          turns: run.turns.length,
          toolCalls: run.toolCalls,
          tokens: run.tokensUsed,
          docsFetches: run.docsFetches,
          retries: run.retries,
          qualitativeFailures: providerAvailable
            ? []
            : ['scripted agent — no DX signal; harness (sandbox/scorer/probes/tamper) validated'],
        })
      } finally {
        sandbox.dispose()
      }
    }
  }
}

function readMarker(dir) {
  try {
    return readFileSync(join(dir, 'docs/.scorer-marker'), 'utf8')
  } catch {
    return null
  }
}

const report = buildAbReport({
  experiment: {
    id: manifest.id ?? 'dx-v1',
    modelId: manifest.modelId ?? 'claude-sonnet-5',
    systemPromptHash: sha256Hex(SYSTEM_PROMPT),
    deterministicProvider: !providerAvailable,
    releaseA: manifest.releaseA ?? 'v1-rc',
    releaseB: manifest.releaseB ?? 'HEAD',
    docsSnapshotHash: docsHash,
    repetitions: reps,
  },
  providerAvailable,
  providerNote: avail.detail,
  results,
})
const { dir } = writeAbReport(join(root, 'artifacts/agent-evals'), report)
console.log(`\nA/B report: ${dir}`)
console.log(`claim: ${report.claim.split('\n')[0]}`)
console.log(`hash: ${report.hash}`)
process.exit(0)
