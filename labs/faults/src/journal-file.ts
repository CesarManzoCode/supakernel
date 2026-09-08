// File-backed phase journal — survives a process crash so `resumeUpgrade` can restart at the
// first unsatisfied postcondition (contract §17.2).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { JournalStore, PhaseJournalEntry } from '@supakernel/schema'

export function fileJournal(path: string): JournalStore {
  return {
    async load(): Promise<PhaseJournalEntry[]> {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as PhaseJournalEntry[]
      } catch {
        return []
      }
    },
    async save(entries): Promise<void> {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`)
    },
  }
}
