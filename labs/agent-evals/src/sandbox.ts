// Disposable eval sandbox (contract §24, §25). Cold start: an empty worktree with only the
// public package + a local docs snapshot. Network deny by default; no inherited cloud / Docker
// / SSH / GitHub tokens; read-only fixtures; validated temp project names.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface SandboxHandle {
  readonly dir: string
  readonly docsDir: string
  /** Env the agent process is given — deliberately stripped of every credential. */
  readonly env: Readonly<Record<string, string>>
  dispose(): void
}

const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'DOCKER_HOST',
  'SSH_AUTH_SOCK',
  'SUPAKERNEL_TEST_PG_URL',
  'SUPAKERNEL_CONF_SB_SERVICE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'CLOUDFLARE_API_TOKEN',
]

export function validateProjectName(name: string): boolean {
  return /^[a-z][a-z0-9-]{2,40}$/.test(name)
}

export function makeSandbox(name: string, docsSnapshot: Record<string, string>): SandboxHandle {
  if (!validateProjectName(name)) throw new Error(`invalid project name: ${name}`)
  const dir = mkdtempSync(join(tmpdir(), `sk-eval-${name}-`))
  const docsDir = join(dir, 'docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(dir, '.eval-sandbox'), name)
  for (const [rel, content] of Object.entries(docsSnapshot)) {
    const p = join(docsDir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED.includes(k)) continue
    if (/API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(k)) continue
    if (v !== undefined) env[k] = v
  }
  env.SUPAKERNEL_EVAL_SANDBOX = dir
  env.NO_NETWORK = '1'

  return {
    dir,
    docsDir,
    env,
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
