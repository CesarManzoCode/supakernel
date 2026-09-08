// `evidence:bundle <diff>` (contract §28, §30 L13). Assembles a human-review-ready evidence
// bundle for a recorded divergence and writes it under artifacts/upstream-evidence/. It never
// publishes — upstream acceptance is external and is not fabricated.

import { join } from 'node:path'
import { buildStorageDivergenceBundle, writeBundle } from '../dist/index.js'

const which = process.argv[2] ?? 'storage-get-missing-object-returns-400'

const builders = {
  'storage-get-missing-object-returns-400': buildStorageDivergenceBundle,
}
const build = builders[which]
if (!build) {
  console.error(`unknown divergence: ${which}. Known: ${Object.keys(builders).join(', ')}`)
  process.exit(2)
}

const bundle = build()
const reproducer = bundle.draftIssue.match(/```sh\n([\s\S]*?)\n```/)?.[1] ?? '#!/bin/sh\n'
const { dir } = writeBundle(join(process.cwd(), 'artifacts/upstream-evidence'), bundle, reproducer)

console.log(`evidence bundle: ${dir}`)
console.log(`  divergence:  ${bundle.divergence.id}`)
console.log(`  signature:   ${bundle.signature}`)
console.log(`  minimal:     ${bundle.minimalSteps.join(' -> ')}`)
console.log(
  `  ownership:   ${bundle.ownership.repo}/${bundle.ownership.path} (score ${bundle.ownership.score.toFixed(2)})`,
)
console.log(`  published:   ${bundle.published}`)
console.log(`  hash:        ${bundle.hash}`)
