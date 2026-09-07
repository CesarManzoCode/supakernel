import { describe, expect, it } from 'vitest'
import { writeReceipt } from '../src/receipt.js'
import { assertProfileReports, assertReceiptComplete } from '../src/runner.js'
import { runNodeProfile } from './run-node-profile.js'

describe('runtime profile — Node 24.20.0 (contract §10, §30 L10)', () => {
  it('runs the common fixture on real HTTP over every DB/blob target and emits a green receipt', async () => {
    const receipt = await runNodeProfile()
    await writeReceipt(receipt)

    const reports = receipt.passList.reduce<
      Map<string, { label: string; cases: { name: string; ok: boolean; error?: string }[] }>
    >((acc, p) => {
      const entry = acc.get(p.target) ?? { label: p.target, cases: [] }
      entry.cases.push({ name: p.name, ok: p.ok, ...(p.error ? { error: p.error } : {}) })
      acc.set(p.target, entry)
      return acc
    }, new Map())
    const asReports = [...reports.values()].map((r) => ({
      label: r.label,
      cases: r.cases,
      total: r.cases.length,
      passed: r.cases.filter((c) => c.ok).length,
      failed: r.cases.filter((c) => !c.ok).length,
    }))

    const scenario = assertProfileReports('node', asReports)
    expect(scenario.failures, scenario.failures.join('\n')).toEqual([])

    const complete = assertReceiptComplete(receipt)
    expect(complete.failures, complete.failures.join('\n')).toEqual([])

    expect(
      receipt.extraChecks.every((c) => c.ok),
      JSON.stringify(receipt.extraChecks, null, 2),
    ).toBe(true)
  }, 180_000)
})
