import { describe, expect, it } from 'vitest'
import { writeReceipt } from '../src/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../src/runner.js'
import {
  LambdaContainerUnavailable,
  type LambdaPrereqs,
  resolveLambdaPrereqs,
  runLambdaProfile,
} from './run-lambda-profile.js'

let prereqs: LambdaPrereqs | null = null
let blocker: string | null = null
try {
  prereqs = await resolveLambdaPrereqs()
} catch (err) {
  if (err instanceof LambdaContainerUnavailable) blocker = err.message
  else blocker = `prerequisites not met: ${(err as Error).message}`
}

describe('runtime profile — AWS Lambda / Node 24 real container (contract §10, §30 L10)', () => {
  it('builds the locked image, runs it under the Lambda emulator and emits a green receipt', async (ctx) => {
    if (!prereqs) {
      // The single sanctioned reason to stop: no real container runtime is available. This is
      // never a silent pass — it prints the precise blocker.
      ctx.skip(`Lambda container gate skipped — ${blocker}`)
      return
    }

    const receipt = await runLambdaProfile(prereqs)
    await writeReceipt(receipt)

    const asReports = [
      {
        label: receipt.passList[0]?.target ?? 'lambda',
        cases: receipt.passList.map((p) => ({ name: p.name, ok: p.ok })),
        total: receipt.passList.length,
        passed: receipt.passList.filter((p) => p.ok).length,
        failed: receipt.passList.filter((p) => !p.ok).length,
      },
    ]
    const scenario = assertProfileReports('lambda', asReports)
    expect(scenario.failures, scenario.failures.join('\n')).toEqual([])

    const complete = assertReceiptComplete(receipt)
    expect(complete.failures, complete.failures.join('\n')).toEqual([])

    expect(
      receipt.extraChecks.every((c) => c.ok),
      JSON.stringify(receipt.extraChecks, null, 2),
    ).toBe(true)

    expect(receipt.runtimeVersion).toMatch(/container/)
  }, 600_000)
})
