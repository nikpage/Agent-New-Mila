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

import { writeAuditLog, deleteAllUserData } from './gdpr'

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
