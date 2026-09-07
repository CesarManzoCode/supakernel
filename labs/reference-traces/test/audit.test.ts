import { describe, expect, it } from 'vitest'
import { auditAll, loadTraces } from '../src/audit.js'
import { auditTrace, coerceTrace } from '../src/schema.js'
import { parseYaml } from '../src/yaml.js'

describe('yaml subset reader', () => {
  it('parses nested maps, block lists and flow lists', () => {
    const doc = parseYaml(`
id: t1
source:
  repository: a/b
  files:
    - x.go
    - y.go
  symbols: [Foo, Bar]
scenarios:
  - s.one
`)
    expect(doc).toEqual({
      id: 't1',
      source: { repository: 'a/b', files: ['x.go', 'y.go'], symbols: ['Foo', 'Bar'] },
      scenarios: ['s.one'],
    })
  })
})

describe('trace audit (contract §18)', () => {
  it('rejects a README-only link with no symbol or test', () => {
    const bad = coerceTrace(
      parseYaml(`
id: bad
source:
  repository: supabase/auth
  commit: 0000000000000000000000000000000000000000
  language: go
  files: [README.md]
  symbols: []
contract: auth.x
scenarios: []
implementation: docs/x.md
license: ""
notes: ""
summary: ""
`),
    )
    const issues = auditTrace(bad, { knownScenarios: new Set() })
    expect(issues.some((i) => i.field === 'source.symbols')).toBe(true)
    expect(issues.some((i) => i.field === 'source.files')).toBe(true)
    expect(issues.some((i) => i.field === 'implementation')).toBe(true)
  })

  it('rejects a floating (non-40-char) source ref', () => {
    const t = coerceTrace(
      parseYaml(`
id: floaty
source:
  repository: PostgREST/postgrest
  commit: main
  language: haskell
  files: [src/x.hs]
  symbols: [Foo]
contract: data.x
scenarios: []
implementation: packages/data/src/x.ts
license: MIT
notes: behavioural reimplementation; no copied code
summary: one two three
`),
    )
    const issues = auditTrace(t, { knownScenarios: new Set() })
    expect(issues.some((i) => i.field === 'source.commit')).toBe(true)
  })

  it('all shipped traces pass and the four gate chains are covered', () => {
    const traces = loadTraces()
    expect(traces.length).toBeGreaterThanOrEqual(4)
    const report = auditAll()
    expect(report.issues, JSON.stringify(report.issues, null, 2)).toEqual([])
    expect(report.missingChains).toEqual([])
    expect(report.ok).toBe(true)
  })
})
