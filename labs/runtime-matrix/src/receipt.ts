import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RuntimeId } from '@supakernel/contracts'
import type { FixtureReport } from '@supakernel/fixture-app'
import { RUNTIME_PROFILES } from './manifest.js'

const receiptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'receipts')

export interface RuntimeReceipt {
  readonly runtime: RuntimeId
  readonly runtimeVersion: string
  readonly coreHash: string
  readonly services: readonly string[]
  readonly databases: readonly string[]
  readonly blobs: readonly string[]
  readonly exclusions: readonly string[]
  readonly capabilityEndpoint: unknown
  /** One entry per scenario case, per exercised (database, blob) pairing. */
  readonly passList: readonly {
    readonly target: string
    readonly name: string
    readonly ok: boolean
    readonly error?: string
  }[]
  readonly extraChecks: readonly {
    readonly name: string
    readonly ok: boolean
    readonly detail?: string
  }[]
  readonly bundleAudit: {
    readonly checked: boolean
    readonly forbidden: readonly string[]
    readonly ok: boolean
  }
}

export interface BuildReceiptInput {
  readonly runtime: RuntimeId
  readonly runtimeVersion: string
  readonly coreHash: string
  readonly capabilityEndpoint: unknown
  readonly reports: readonly FixtureReport[]
  readonly extraChecks?: readonly { name: string; ok: boolean; detail?: string }[]
  readonly bundleAudit?: { checked: boolean; forbidden: readonly string[]; ok: boolean }
}

export function buildReceipt(input: BuildReceiptInput): RuntimeReceipt {
  const profile = RUNTIME_PROFILES[input.runtime]
  const passList = input.reports.flatMap((r) =>
    r.cases.map((c) => ({
      target: r.label,
      name: c.name,
      ok: c.ok,
      ...(c.error ? { error: c.error } : {}),
    })),
  )
  return {
    runtime: input.runtime,
    runtimeVersion: input.runtimeVersion,
    coreHash: input.coreHash,
    services: [...profile.services],
    databases: [...profile.databases],
    blobs: [...profile.blobs],
    exclusions: [...profile.exclusions],
    capabilityEndpoint: input.capabilityEndpoint,
    passList,
    extraChecks: (input.extraChecks ?? []).map((c) => ({
      name: c.name,
      ok: c.ok,
      ...(c.detail ? { detail: c.detail } : {}),
    })),
    bundleAudit: input.bundleAudit ?? { checked: false, forbidden: [], ok: true },
  }
}

export function receiptIsGreen(receipt: RuntimeReceipt): boolean {
  return (
    receipt.passList.length > 0 &&
    receipt.passList.every((p) => p.ok) &&
    receipt.extraChecks.every((c) => c.ok) &&
    receipt.bundleAudit.ok
  )
}

export async function writeReceipt(receipt: RuntimeReceipt): Promise<string> {
  await mkdir(receiptsDir, { recursive: true })
  const path = join(receiptsDir, `${receipt.runtime}.json`)
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`)
  return path
}
