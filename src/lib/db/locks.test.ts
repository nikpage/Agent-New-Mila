import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
vi.mock('../supabase/client', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

import { tryAcquireUserLock, releaseUserLock } from './locks'

function chainable(finalResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'in', 'lt', 'not', 'order', 'limit']
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain['single'] = vi.fn().mockResolvedValue(finalResult)
  ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(finalResult)
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tryAcquireUserLock', () => {
  it('returns false when lock is held (insert fails with unique violation)', async () => {
    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: delete expired (cleanup)
        return chainable({ data: null, error: null })
      }
      // Second call: insert — fails with unique constraint
      const chain = chainable()
      chain['insert'] = vi.fn().mockReturnValue(chain)
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: null, error: { message: 'duplicate key', code: '23505' } })
      return chain
    })

    const acquired = await tryAcquireUserLock('user-1')
    expect(acquired).toBe(false)
  })
})

describe('releaseUserLock', () => {
  it('deletes the lock row filtered by user_id', async () => {
    const deleteChain = chainable()
    mockFrom.mockReturnValue(deleteChain)

    await releaseUserLock('user-1')

    expect(mockFrom).toHaveBeenCalledWith('user_agent_locks')
    expect(deleteChain.delete).toHaveBeenCalled()
    expect(deleteChain.eq).toHaveBeenCalledWith('user_id', 'user-1')
  })
})
