import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCli } from '../src/cli.js'

describe('sk CLI (contract §27, §30 L9)', () => {
  let dir: string
  const out: string[] = []
  const err: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sk-cli-'))
    out.length = 0
    err.length = 0
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const run = (args: string[]): Promise<void> => {
    out.length = 0
    err.length = 0
    const cli = buildCli({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir })
    return cli.parseAsync(['node', 'sk', ...args]).then(() => undefined)
  }

  it('init writes config + schema without a dashboard install', async () => {
    await run(['init'])
    expect(await readFile(join(dir, 'supakernel', 'config.ts'), 'utf8')).toContain('projectRef')
    expect(await readFile(join(dir, 'supakernel', 'schema', '0001_init.sql'), 'utf8')).toContain(
      'CREATE TABLE notes',
    )
  })

  it('doctor --json reports the runtime and config state', async () => {
    await run(['init'])
    await run(['doctor', '--json'])
    const report = JSON.parse(out.join(''))
    expect(report.node).toBe(process.versions.node)
    expect(report.config_present).toBe(true)
    expect(report.schema_files).toBe(1)
  })

  it('capabilities --json prints the effective matrix', async () => {
    await run(['capabilities', '--json'])
    const caps = JSON.parse(out.join(''))
    expect(caps.services.data).toBe(true)
    expect(caps.exclusions).toContain('rpc')
  })

  it('types generates deterministic TypeScript from the schema; a non-typescript lang is refused', async () => {
    await run(['init'])
    await run(['types', '--lang', 'typescript'])
    const first = out.join('')
    out.length = 0
    await run(['types', '--lang', 'typescript'])
    expect(out.join('')).toBe(first)
    expect(first).toContain('export interface Database')

    out.length = 0
    await run(['types', '--lang', 'go'])
    expect(err.join('')).toMatch(/unsupported language/)
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })

  it('db diff prints a stable schema hash', async () => {
    await run(['init'])
    await run(['db', 'diff', '--name', 'x'])
    const a = JSON.parse(out.join(''))
    out.length = 0
    await run(['db', 'diff', '--name', 'x'])
    expect(JSON.parse(out.join('')).hash).toBe(a.hash)
  })

  it('start never mutates the schema implicitly', async () => {
    await run(['init'])
    await run(['start'])
    expect(out.join('')).toMatch(/never mutates it/)
  })
})
