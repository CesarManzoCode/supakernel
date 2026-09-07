/**
 * `Prefer` header parsing (contract §11.1). Supported tokens: `return=representation|minimal`,
 * `count=exact`, `resolution=merge-duplicates|ignore-duplicates`, `missing=default`.
 */
export interface Preferences {
  readonly return: 'representation' | 'minimal'
  readonly count: 'none' | 'exact'
  readonly resolution: 'error' | 'merge' | 'ignore'
  readonly missing: 'null' | 'default'
  /** Tokens that were present but are outside the subset. */
  readonly unsupported: readonly string[]
}

export function parsePrefer(header: string | null | undefined): Preferences {
  const tokens = (header ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  let ret: Preferences['return'] = 'minimal'
  let count: Preferences['count'] = 'none'
  let resolution: Preferences['resolution'] = 'error'
  let missing: Preferences['missing'] = 'null'
  const unsupported: string[] = []

  for (const token of tokens) {
    const [rawKey, rawValue] = token.split('=', 2)
    const key = (rawKey ?? '').trim().toLowerCase()
    const value = (rawValue ?? '').trim().toLowerCase()
    switch (key) {
      case 'return':
        if (value === 'representation' || value === 'minimal') ret = value
        else unsupported.push(token)
        break
      case 'count':
        if (value === 'exact') count = 'exact'
        else unsupported.push(token) // planned / estimated are unsupported (§11.2)
        break
      case 'resolution':
        if (value === 'merge-duplicates') resolution = 'merge'
        else if (value === 'ignore-duplicates') resolution = 'ignore'
        else unsupported.push(token)
        break
      case 'missing':
        if (value === 'default') missing = 'default'
        else unsupported.push(token)
        break
      case 'handling':
        // `handling=strict|lenient` — accepted and ignored (matches vendor leniency).
        break
      default:
        unsupported.push(token)
    }
  }

  return { return: ret, count, resolution, missing, unsupported }
}
