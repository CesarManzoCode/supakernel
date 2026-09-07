import { describe, expect, it } from 'vitest'
import { writeReceipt } from '../src/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../src/runner.js'
import { runLambdaProfile } from './run-lambda-profile.js'

const ready = Boolean(process.env.SUPAKERNEL_TEST_PG_URL) && process.env.SUPAKERNEL_TEST_S3 === '1'

describe.skipIf(!ready)(
  'runtime profile — AWS Lambda / Node 24 container (contract §10, §30 L10)',
  () => {
    it('runs the common fixture through a real API Gateway v2 invocation and emits a green receipt', async () => {
      const receipt = await runLambdaProfile()
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
    }, 180_000)
  },
)
