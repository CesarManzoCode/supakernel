import { describe, expect, it } from 'vitest'
import {
  type ClockPort,
  createMemoryMailSink,
  type DatabaseAdapter,
  NULL_FAULT_PORT,
  type RandomPort,
} from '../src/index.js'

describe('ports — shape and defaults', () => {
  it('NULL_FAULT_PORT.hit resolves for every named fault point', async () => {
    await expect(NULL_FAULT_PORT.hit('migration.before_step')).resolves.toBeUndefined()
    await expect(
      NULL_FAULT_PORT.hit('auth.after_parent_cas', { sessionId: 's' }),
    ).resolves.toBeUndefined()
  })

  it('MemoryMailSink records and clears sent messages', async () => {
    const sink = createMemoryMailSink()
    await sink.send({ to: 'a@example.com', templateId: 'recover', variables: { token: 'x' } })
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]?.templateId).toBe('recover')
    sink.clear()
    expect(sink.sent).toHaveLength(0)
  })

  it('a minimal fake adapter satisfies the DatabaseAdapter type', () => {
    const fake: Pick<DatabaseAdapter, 'id' | 'runtime' | 'capabilities'> = {
      id: 'fake',
      runtime: 'node',
      capabilities: {
        family: 'sqlite',
        transactions: 'callback',
        ddlAtomicity: 'transactional',
        nativeRls: false,
        returning: true,
        json: 'json-text',
        changeCapture: 'managed-triggers',
        isolation: ['serializable'],
      },
    }
    expect(fake.capabilities.family).toBe('sqlite')
  })

  it('clock and random ports are structurally usable', () => {
    const clock: ClockPort = {
      now: () => '2026-09-06T00:00:00.000Z',
      epochMillis: () => 0,
      monotonicMillis: () => 0,
    }
    const random: Pick<RandomPort, 'uuidV4'> = {
      uuidV4: () => '00000000-0000-4000-8000-000000000000',
    }
    expect(clock.now()).toContain('T')
    expect(random.uuidV4()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
