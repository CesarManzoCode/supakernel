// `conformance:replay -- <artifact>` (contract §30 L11). Fully offline: no network, no client
// library. The lane commands (`conformance:pr` / `:nightly` / `--capability`) run through
// vitest via runtime/conformance.mjs, which wires the real targets.

import { resolve } from 'node:path'
import { replay } from './replay.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'replay'

if (command !== 'replay') {
  console.error(`unknown command: ${command} (only "replay" is offline)`)
  process.exit(2)
}

const artifact = args.find((a) => a !== 'replay' && !a.startsWith('-'))
if (!artifact) {
  console.error('usage: pnpm conformance:replay -- <artifact-dir>')
  process.exit(2)
}

const result = replay(resolve(artifact), 3)
console.log(JSON.stringify(result.perPass[0], null, 2))
if (!result.checksumOk) {
  console.error('checksum mismatch:', result.checksumMismatches.join(', '))
  process.exit(5)
}
console.log(
  result.hashIdentical
    ? `REPLAY: ${result.perPass.length}/${result.perPass.length} hash-identical`
    : 'REPLAY: DIVERGENT',
)
process.exit(result.hashIdentical ? 0 : 5)
