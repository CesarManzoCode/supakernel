// Phase `cutover-receipt` (contract §17.2, §26). A signed, secret-free journal of the
// upgrade. HMAC-SHA256 over the canonical body — deterministic and independently checkable.

import type { Json } from '@supakernel/contracts'
import { canonicalJson, sha256Hex } from '@supakernel/contracts'
import type { Fingerprint, PhaseJournalEntry, UpgradeReceipt } from './types.js'

const SECRET_KEY_RE = /encrypted_password|password|token|secret|jwk|signature|private/i

function scrub(value: Json): Json {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === 'object') {
    const out: { [k: string]: Json } = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '<redacted>' : scrub(v as Json)
    }
    return out
  }
  return value
}

/** Portable HMAC-SHA256 built on the dependency-free sha256 (contract §7 portability). */
export function hmacSha256Hex(key: string, message: string): string {
  const enc = new TextEncoder()
  const blockSize = 64
  const rawKey = enc.encode(key)
  const keyBytes: Uint8Array =
    rawKey.length > blockSize ? hexToBytes(sha256Hex(key)) : hexToBytes(bytesToHex(rawKey))
  const padded = new Uint8Array(blockSize)
  padded.set(keyBytes)
  const oKey = new Uint8Array(blockSize)
  const iKey = new Uint8Array(blockSize)
  for (let i = 0; i < blockSize; i++) {
    oKey[i] = (padded[i] ?? 0) ^ 0x5c
    iKey[i] = (padded[i] ?? 0) ^ 0x36
  }
  const inner = sha256Hex(bytesToLatin1(iKey) + message)
  return sha256Hex(bytesToLatin1(oKey) + latin1FromHex(inner))
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}
function latin1FromHex(hex: string): string {
  return bytesToLatin1(hexToBytes(hex))
}

export interface BuildReceiptInput {
  readonly planId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly source: Fingerprint
  readonly target: Fingerprint
  readonly journal: readonly PhaseJournalEntry[]
  readonly invariants: readonly { name: string; ok: boolean; detail: string }[]
  readonly sessionsRevoked: boolean
  readonly receiptKey: string
}

export function buildReceipt(input: BuildReceiptInput): UpgradeReceipt {
  // Complete iff every invariant held and every phase the import actually ran ended
  // `applied` — a `failed` / `compensated` / mid-flight `running` phase makes it incomplete.
  const ranPhases = input.journal.filter((j) => j.startedAt !== null || j.state !== 'pending')
  const status: 'complete' | 'incomplete' =
    input.invariants.every((i) => i.ok) &&
    ranPhases.length > 0 &&
    ranPhases.every((j) => j.state === 'applied' && j.postcondition !== false)
      ? 'complete'
      : 'incomplete'
  const body = {
    schemaVersion: 1 as const,
    planId: input.planId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    source: scrub(input.source as unknown as Json),
    target: scrub(input.target as unknown as Json),
    journal: input.journal as unknown as Json,
    invariants: input.invariants as unknown as Json,
    sessionsRevoked: input.sessionsRevoked,
    status,
  }
  const signature = hmacSha256Hex(input.receiptKey, canonicalJson(body as unknown as Json))
  return { ...(body as unknown as UpgradeReceipt), signature }
}

export function verifyReceipt(receipt: UpgradeReceipt, receiptKey: string): boolean {
  const { signature: _sig, ...body } = receipt
  return hmacSha256Hex(receiptKey, canonicalJson(body as unknown as Json)) === receipt.signature
}
