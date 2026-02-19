import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock getSupabaseAdmin before importing the module under test
const mockFrom = vi.fn()
vi.mock('../supabase/client', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}))

import { writeAuditLog, deleteAllUserData, exportAllUserData, enforceRetentionPolicy } from './gdpr'

/** Helper to build a chainable Supabase query mock */
function chainable(finalResult: { data: unknown; error: unknown } = { data: [], error: null }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'in', 'lt', 'not', 'order', 'limit']
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain['single'] = vi.fn().mockResolvedValue(finalResult)
  // Make the chain itself resolve for non-.single() queries
  ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(finalResult)
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('writeAuditLog', () => {
  it('inserts into audit_logs table', async () => {
    const chain = chainable()
    mockFrom.mockReturnValue(chain)

    await writeAuditLog({ user_id: 'user-1', action: 'test_action' })

    expect(mockFrom).toHaveBeenCalledWith('audit_logs')
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        action: 'test_action',
      })
    )
  })

  it('never throws even on Supabase error', async () => {
    const chain = chainable({ data: null, error: { message: 'DB down' } })
    mockFrom.mockReturnValue(chain)

    // Should not throw
    await expect(writeAuditLog({ user_id: 'u', action: 'a' })).resolves.toBeUndefined()
  })

  it('never throws even on exception', async () => {
    mockFrom.mockImplementation(() => { throw new Error('boom') })

    await expect(writeAuditLog({ user_id: 'u', action: 'a' })).resolves.toBeUndefined()
  })
})

describe('deleteAllUserData', () => {
  it('deletes tables in FK-safe order', async () => {
    // Track the order of from() calls
    const callOrder: string[] = []
    mockFrom.mockImplementation((table: string) => {
      callOrder.push(table)
      return chainable({ data: [{ id: 'x' }], error: null })
    })

    await deleteAllUserData('user-1')

    // Verify FK-safe ordering: leaf tables first, then parents, then user
    const emailsIdx = callOrder.indexOf('emails')
    const actionsIdx = callOrder.lastIndexOf('action_proposals')
    const msgsDeleteIdx = callOrder.lastIndexOf('messages')
    const convsIdx = callOrder.lastIndexOf('conversation_threads')
    const cpsIdx = callOrder.lastIndexOf('cps')
    const usersIdx = callOrder.lastIndexOf('users')

    // emails before action_proposals (FK dependency)
    expect(emailsIdx).toBeLessThan(actionsIdx)
    // action_proposals before conversations
    expect(actionsIdx).toBeLessThan(convsIdx)
    // messages before conversations
    expect(msgsDeleteIdx).toBeLessThan(convsIdx)
    // conversations before cps
    expect(convsIdx).toBeLessThan(cpsIdx)
    // cps before users
    expect(cpsIdx).toBeLessThan(usersIdx)
    // users is last
    expect(usersIdx).toBe(callOrder.lastIndexOf('users'))
  })

  it('returns row counts per table', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'messages') {
        return chainable({ data: [{ id: '1' }, { id: '2' }], error: null })
      }
      if (table === 'cps') {
        return chainable({ data: [{ id: 'cp1' }], error: null })
      }
      return chainable({ data: [], error: null })
    })

    const counts = await deleteAllUserData('user-1')

    expect(counts.messages).toBe(2)
    expect(counts.cps).toBe(1)
    expect(counts.emails).toBe(0)
    expect(typeof counts.users).toBe('number')
  })

  it('handles lock table not existing gracefully', async () => {
    let callCount = 0
    mockFrom.mockImplementation((table: string) => {
      callCount++
      if (table === 'user_agent_locks') {
        throw new Error('relation "user_agent_locks" does not exist')
      }
      return chainable({ data: [], error: null })
    })

    const counts = await deleteAllUserData('user-1')
    expect(counts.user_agent_locks).toBe(0)
  })
})

describe('exportAllUserData', () => {
  it('returns structured export with all sections', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'users') {
        return chainable({ data: { id: 'user-1', email: 'test@test.com' }, error: null })
      }
      return chainable({ data: [], error: null })
    })

    const exported = await exportAllUserData('user-1')

    expect(exported.user_id).toBe('user-1')
    expect(exported.exported_at).toBeTruthy()
    expect(exported.user).toEqual({ id: 'user-1', email: 'test@test.com' })
    expect(exported.counterparties).toEqual([])
    expect(exported.messages).toEqual([])
    expect(exported.actions).toEqual([])
  })

  it('handles errors per-table without crashing', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'messages') {
        throw new Error('DB error on messages')
      }
      return chainable({ data: [], error: null })
    })

    // Should not throw — errors are handled per-table
    const exported = await exportAllUserData('user-1')
    expect(exported.user_id).toBe('user-1')
  })
})

describe('enforceRetentionPolicy', () => {
  it('scrubs old message text and deletes embeddings', async () => {
    const oldMsgIds = [{ id: 'msg-old-1' }, { id: 'msg-old-2' }]
    const updateCalls: string[] = []

    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'insert', 'update', 'delete', 'eq', 'in', 'lt', 'not', 'order', 'limit']
      for (const m of methods) {
        chain[m] = vi.fn().mockImplementation((..._args: unknown[]) => {
          if (m === 'update') updateCalls.push(table)
          return chain
        })
      }
      chain['single'] = vi.fn().mockResolvedValue({ data: null, error: null })

      if (table === 'messages' && updateCalls.length === 0) {
        // First messages query returns old IDs
        ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
          resolve({ data: oldMsgIds, error: null })
      } else if (table === 'message_embeddings') {
        ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
          resolve({ data: [{ message_id: 'msg-old-1' }], error: null })
      } else {
        ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
          resolve({ data: oldMsgIds, error: null })
      }
      return chain
    })

    const result = await enforceRetentionPolicy('user-1', 90)

    expect(result.messagesScrubbed).toBe(2)
    expect(result.embeddingsDeleted).toBe(1)
  })

  it('returns zeros when no old messages exist', async () => {
    mockFrom.mockImplementation(() => {
      return chainable({ data: [], error: null })
    })

    const result = await enforceRetentionPolicy('user-1', 90)
    expect(result.messagesScrubbed).toBe(0)
    expect(result.embeddingsDeleted).toBe(0)
  })
})
