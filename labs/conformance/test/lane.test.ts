// Conformance lane gate (contract §19, §31 Data/Auth/Storage/Realtime/Management rows,
// §30 L11 DONE). Runs the same ScenarioSpec set against every mandatory available target,
// writes an immutable artifact set, and fails on any unclassified diff on the included
// surface. Then replays the artifacts three times offline and asserts hash-identity.

import { afterAll, describe, expect, it } from 'vitest'
import { replay } from '../src/index.js'
import { runLane } from './support/lane.js'

const lane = (process.env.SUPAKERNEL_CONF_LANE as 'pr' | 'nightly') ?? 'pr'
const capability = process.env.SUPAKERNEL_CONF_CAPABILITY
// This lane needs the Supabase-local oracle. The dedicated gate command
// (`pnpm conformance:pr`) discovers and exports it; a bare `pnpm test` skips the lane the
// same way the S3 and Lambda gates are opt-in.
const configured = Boolean(process.env.SUPAKERNEL_CONF_SB_API_URL)
const suite = configured ? describe : describe.skip

let artifactDir = ''

suite(`conformance ${lane}${capability ? ` [${capability}]` : ''} (contract §19, §31)`, () => {
  it('same ScenarioSpec runs against all mandatory available targets with no unclassified diff', async () => {
    const result = await runLane({ lane, ...(capability ? { capability } : {}) })
    artifactDir = result.artifactDir

    // eslint-disable-next-line no-console
    console.log(
      '\n' +
        result.summary.reports
          .map((r) => {
            const parts = r.classifications.map(
              (c) => `${c.target}=${c.classification.class}${c.classification.blocking ? '!' : ''}`,
            )
            return `  ${r.capability}/${r.scenario} [oracle ${r.oracle}] ${parts.join(' ') || '(oracle only)'}`
          })
          .join('\n'),
    )
    console.log('  by class:', JSON.stringify(result.summary.byClass))
    console.log('  artifact:', result.artifactDir)
    console.log('  manifest:', result.manifestHash)

    expect(
      result.missingMandatory,
      `missing mandatory targets: ${result.missingMandatory.join(', ')}`,
    ).toEqual([])
    if (capability === undefined || ['data', 'auth', 'storage', 'realtime'].includes(capability)) {
      expect(
        result.oracleRan,
        'the supabase-local oracle must have run for at least one scenario',
      ).toBe(true)
    }
    expect(result.summary.byClass.kernel_regression, 'kernel_regression diffs').toBe(0)
    expect(result.summary.totalUnclassified, 'unclassified diffs on the included surface').toBe(0)
    expect(result.summary.totalBlocking, 'blocking classifications').toBe(0)
    expect(result.ok).toBe(true)
  }, 600_000)

  it('artifacts replay hash-identical three times offline (contract §19.2)', () => {
    expect(artifactDir).not.toBe('')
    const r = replay(artifactDir, 3)
    expect(r.checksumOk, `checksum mismatches: ${r.checksumMismatches.join(', ')}`).toBe(true)
    expect(r.hashIdentical, 'three offline replays must be byte-identical').toBe(true)
    expect(r.perPass).toHaveLength(3)
  })
})

afterAll(() => {
  if (artifactDir) console.log(`conformance artifacts: ${artifactDir}`)
})

if (!configured) {
  describe('conformance lane (skipped)', () => {
    it.skip('needs the Supabase-local oracle — run `pnpm conformance:pr`', () => {})
  })
}
