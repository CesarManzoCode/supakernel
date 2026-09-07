#!/usr/bin/env node
import { buildCli } from './cli.js'

const program = buildCli({
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
})

program.parseAsync(process.argv).catch((err: unknown) => {
  const code = (err as { exitCode?: number }).exitCode
  if (typeof code === 'number') process.exit(code)
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(2)
})
