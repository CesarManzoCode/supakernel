import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const srcDir = join(import.meta.dirname, '..', 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) out.push(...tsFiles(full))
    else if (name.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('contracts have zero `any`', () => {
  it('no source file contains a bare `any` type', () => {
    const offenders: string[] = []
    for (const file of tsFiles(srcDir)) {
      const text = readFileSync(file, 'utf8')
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      if (/(^|[^A-Za-z_$])any(\[\])?([^A-Za-z_$]|$)/.test(stripped)) {
        offenders.push(file.replace(srcDir, 'src'))
      }
    }
    expect(offenders, offenders.join(', ')).toEqual([])
  })

  it('the built declaration bundle type-checks under isolatedDeclarations with skipLibCheck:false', () => {
    // `pnpm typecheck` at the repo root runs this too; assert it here for the contracts project.
    const out = execFileSync(
      'node',
      ['../../node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.json', '--pretty', 'false'],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' },
    )
    expect(out).not.toMatch(/error TS/)
  })
})
