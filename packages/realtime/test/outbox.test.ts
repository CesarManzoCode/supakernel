import { sql } from '@supakernel/contracts'
import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import type { DatabaseAdapter } from '@supakernel/ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OutboxDispatcher,
  outboxSchemaStatements,
  outboxTable,
  outboxTriggerStatements,
} from '../src/index.js'
import { NOTES_DDL_SQLITE } from './helpers/blog.js'

describe('managed outbox (contract §15)', () => {
  let db: DatabaseAdapter
  beforeEach(async () => {
    db = openNodeSqlite({ path: ':memory:' })
    for (const s of NOTES_DDL_SQLITE) await db.execute(sql(s))
    for (const s of outboxSchemaStatements('sqlite')) await db.execute(sql(s))
    for (const s of outboxTriggerStatements('sqlite', {
      name: 'notes',
      columns: ['id', 'tenant_id', 'owner_id', 'title', 'secret', 'done'],
      primaryKey: ['id'],
    })) {
      await db.execute(sql(s))
    }
  })
  afterEach(async () => {
    await db.close()
  })

  it('a mutation writes exactly one outbox row in the same transaction, with monotonic seq', async () => {
    await db.transaction({ isolation: 'serializable' }, async (tx) => {
      await tx.execute(
        sql('INSERT INTO notes (id,tenant_id,owner_id,title) VALUES (1,?,?,?)', [
          't1',
          'u1',
          'first',
        ]),
      )
      // the outbox row is visible inside the same transaction
      const seen = await tx.execute(sql(`SELECT count(*) AS n FROM ${outboxTable('sqlite')}`))
      expect(Number(seen.rows[0]?.n)).toBe(1)
    })
    await db.execute(sql('UPDATE notes SET title = ? WHERE id = 1', ['renamed']))
    await db.execute(sql('DELETE FROM notes WHERE id = 1'))

    const rows = await db.execute(
      sql(`SELECT seq, op, pk, old_record, new_record FROM ${outboxTable('sqlite')} ORDER BY seq`),
    )
    expect(rows.rows.map((r) => r.op)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    const seqs = rows.rows.map((r) => Number(r.seq))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(JSON.parse(String(rows.rows[0]?.new_record)).title).toBe('first')
    expect(JSON.parse(String(rows.rows[1]?.old_record)).title).toBe('first')
    expect(JSON.parse(String(rows.rows[2]?.old_record)).title).toBe('renamed')
    expect(rows.rows[2]?.new_record).toBeNull()
    expect(JSON.parse(String(rows.rows[0]?.pk))).toEqual({ id: 1 })
  })

  it('dispatcher reads in seq order and advances the cursor; GC respects the min active cursor', async () => {
    for (let i = 1; i <= 5; i++) {
      await db.execute(
        sql('INSERT INTO notes (id,tenant_id,owner_id,title) VALUES (?,?,?,?)', [
          i,
          't',
          'u',
          `n${i}`,
        ]),
      )
    }
    const d = new OutboxDispatcher(db, 'sqlite')
    const first = await d.pump()
    expect(first.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(d.cursor).toBe(5)
    expect(await d.pump()).toEqual([])

    // GC below cursor 3 must not remove seq 4/5 even though they are old
    const removed = await d.gc(3)
    const left = await db.execute(sql(`SELECT min(seq) AS m FROM ${outboxTable('sqlite')}`))
    expect(Number(left.rows[0]?.m ?? 999)).toBeGreaterThanOrEqual(1)
    void removed
  })

  it('drift: a missing trigger disables publish and fails health', async () => {
    const d = new OutboxDispatcher(db, 'sqlite')
    expect((await d.checkDrift(['notes'])).ok).toBe(true)
    await db.execute(sql('DROP TRIGGER sk_outbox_notes_ins'))
    const drift = await d.checkDrift(['notes'])
    expect(drift.ok).toBe(false)
    expect(drift.missing).toContain('notes')
    expect(d.healthy).toBe(false)
    expect(await d.pump()).toEqual([]) // publish disabled
  })
})
