import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
vi.mock('../supabase/client', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

import {
  getActiveJournalEntries,
  getJournalEntriesForContext,
  getRecentJournalEntries,
  getAllBeliefs,
  createJournalEntry,
  confirmObservation,
  recordConflict,
  findMatchingEntry,
  replaceBeliefContent,
  markStaleByConversation,
  expireTemporalEntries,
  deleteJournalEntry,
  createJournalEntries,
} from './journal'

// Chainable mock helper (same pattern as locks.test.ts)
function chainable(finalResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'lt', 'lte', 'gte', 'not', 'neq', 'is', 'order', 'limit', 'or', 'single', 'maybeSingle']
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  // Terminal methods resolve
  chain['single'] = vi.fn().mockResolvedValue(finalResult)
  chain['maybeSingle'] = vi.fn().mockResolvedValue(finalResult)
  // Default thenable for non-single queries
  ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(finalResult)
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getActiveJournalEntries', () => {
  it('queries journal_entries filtered by user_id and is_stale=false', async () => {
    const entries = [{ id: 'j1', topic: 'test', weight: 0.5 }]
    const chain = chainable({ data: entries, error: null })
    mockFrom.mockReturnValue(chain)

    const result = await getActiveJournalEntries('user-1')

    expect(mockFrom).toHaveBeenCalledWith('journal_entries')
    expect(chain.select).toHaveBeenCalledWith('*')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('is_stale', false)
    expect(chain.order).toHaveBeenCalledWith('weight', { ascending: false })
    expect(result).toEqual(entries)
  })

  it('applies scope filter when provided', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getActiveJournalEntries('user-1', { scope: 'global' })

    expect(chain.eq).toHaveBeenCalledWith('scope', 'global')
  })

  it('applies scopeRef filter when provided', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getActiveJournalEntries('user-1', { scopeRef: 'cp-123' })

    expect(chain.eq).toHaveBeenCalledWith('scope_ref', 'cp-123')
  })

  it('applies types filter when provided', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getActiveJournalEntries('user-1', { types: ['belief', 'volatile'] })

    expect(chain.in).toHaveBeenCalledWith('type', ['belief', 'volatile'])
  })

  it('applies limit (default 50)', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getActiveJournalEntries('user-1')

    expect(chain.limit).toHaveBeenCalledWith(50)
  })

  it('applies custom limit', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getActiveJournalEntries('user-1', { limit: 20 })

    expect(chain.limit).toHaveBeenCalledWith(20)
  })

  it('throws on DB error', async () => {
    const chain = chainable({ data: null, error: { message: 'DB down' } })
    mockFrom.mockReturnValue(chain)

    await expect(getActiveJournalEntries('user-1')).rejects.toThrow('Failed to get active journal entries')
  })
})

describe('getJournalEntriesForContext', () => {
  it('queries with global + conversation + cp scopes', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getJournalEntriesForContext('user-1', ['conv-1'], ['cp-1'])

    expect(mockFrom).toHaveBeenCalledWith('journal_entries')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('is_stale', false)
    // Should use .or() to match global OR conversation_id OR cp_id scopes
    expect(chain.or).toHaveBeenCalled()
  })
})

describe('getRecentJournalEntries', () => {
  it('queries entries from last 7 days by default', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await getRecentJournalEntries('user-1')

    expect(mockFrom).toHaveBeenCalledWith('journal_entries')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('is_stale', false)
  })
})

describe('getAllBeliefs', () => {
  it('queries non-stale beliefs for user', async () => {
    const beliefs = [{ id: 'b1', type: 'belief', topic: 'style' }]
    const chain = chainable({ data: beliefs, error: null })
    mockFrom.mockReturnValue(chain)

    const result = await getAllBeliefs('user-1')

    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('is_stale', false)
    expect(chain.eq).toHaveBeenCalledWith('type', 'belief')
    expect(result).toEqual(beliefs)
  })
})

describe('createJournalEntry', () => {
  it('inserts and returns the new entry', async () => {
    const entry = { id: 'j1', user_id: 'user-1', scope: 'global', topic: 'style', content: 'prefers short replies' }
    const chain = chainable({ data: entry, error: null })
    mockFrom.mockReturnValue(chain)

    const result = await createJournalEntry({
      user_id: 'user-1',
      scope: 'global',
      topic: 'style',
      content: 'prefers short replies',
    })

    expect(mockFrom).toHaveBeenCalledWith('journal_entries')
    expect(chain.insert).toHaveBeenCalled()
    expect(result).toEqual(entry)
  })

  it('throws on insert error', async () => {
    const chain = chainable()
    chain['single'] = vi.fn().mockResolvedValue({ data: null, error: { message: 'constraint violation' } })
    mockFrom.mockReturnValue(chain)

    await expect(createJournalEntry({
      user_id: 'user-1',
      scope: 'global',
      topic: 'test',
      content: 'test',
    })).rejects.toThrow('Failed to create journal entry')
  })
})

describe('confirmObservation', () => {
  it('increments confirm_count and updates recency', async () => {
    // First call: get current entry
    const currentEntry = { id: 'j1', confirm_count: 2, type: 'observation', weight: 0.2 }
    const getChain = chainable({ data: currentEntry, error: null })

    // Second call: update
    const updatedEntry = { ...currentEntry, confirm_count: 3, type: 'belief' }
    const updateChain = chainable({ data: updatedEntry, error: null })

    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      return callCount === 1 ? getChain : updateChain
    })

    const result = await confirmObservation('j1')

    expect(result).toEqual(updatedEntry)
  })

  it('promotes to belief when confirm_count reaches 3', async () => {
    const currentEntry = { id: 'j1', confirm_count: 2, type: 'observation', weight: 0.2 }
    const getChain = chainable({ data: currentEntry, error: null })
    const updateChain = chainable({ data: { ...currentEntry, confirm_count: 3, type: 'belief' }, error: null })

    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      return callCount === 1 ? getChain : updateChain
    })

    await confirmObservation('j1')

    // The update call should set type to 'belief'
    const updateCall = (updateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateCall.type).toBe('belief')
    expect(updateCall.confirm_count).toBe(3)
  })

  it('keeps type as belief when already promoted', async () => {
    const currentEntry = { id: 'j1', confirm_count: 5, type: 'belief', weight: 2.0 }
    const getChain = chainable({ data: currentEntry, error: null })
    const updateChain = chainable({ data: { ...currentEntry, confirm_count: 6 }, error: null })

    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      return callCount === 1 ? getChain : updateChain
    })

    await confirmObservation('j1')

    const updateCall = (updateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateCall.type).toBe('belief')
    expect(updateCall.confirm_count).toBe(6)
  })
})

describe('recordConflict', () => {
  it('increments conflict_count', async () => {
    const currentEntry = { id: 'j1', conflict_count: 1, type: 'belief' }
    const getChain = chainable({ data: currentEntry, error: null })
    const updateChain = chainable({ data: { ...currentEntry, conflict_count: 2 }, error: null })

    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      return callCount === 1 ? getChain : updateChain
    })

    await recordConflict('j1')

    const updateCall = (updateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateCall.conflict_count).toBe(2)
  })

  it('flags as volatile when conflict_count reaches 3', async () => {
    const currentEntry = { id: 'j1', conflict_count: 2, type: 'belief' }
    const getChain = chainable({ data: currentEntry, error: null })
    const updateChain = chainable({ data: { ...currentEntry, conflict_count: 3, type: 'volatile' }, error: null })

    let callCount = 0
    mockFrom.mockImplementation(() => {
      callCount++
      return callCount === 1 ? getChain : updateChain
    })

    await recordConflict('j1')

    const updateCall = (updateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateCall.type).toBe('volatile')
    expect(updateCall.conflict_count).toBe(3)
  })
})

describe('findMatchingEntry', () => {
  it('matches on user_id + scope + scope_ref + topic', async () => {
    const entry = { id: 'j1', topic: 'style' }
    const chain = chainable({ data: entry, error: null })
    mockFrom.mockReturnValue(chain)

    const result = await findMatchingEntry('user-1', 'global', null, 'style')

    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('scope', 'global')
    expect(chain.eq).toHaveBeenCalledWith('topic', 'style')
    expect(chain.is).toHaveBeenCalledWith('scope_ref', null)
    expect(result).toEqual(entry)
  })

  it('uses eq for non-null scope_ref', async () => {
    const chain = chainable({ data: null, error: null })
    mockFrom.mockReturnValue(chain)

    await findMatchingEntry('user-1', 'cp_id', 'cp-123', 'response time')

    expect(chain.eq).toHaveBeenCalledWith('scope_ref', 'cp-123')
  })

  it('returns null when no match', async () => {
    const chain = chainable({ data: null, error: null })
    mockFrom.mockReturnValue(chain)

    const result = await findMatchingEntry('user-1', 'global', null, 'nonexistent')
    expect(result).toBeNull()
  })
})

describe('replaceBeliefContent', () => {
  it('updates content and optionally resets counts', async () => {
    const chain = chainable({ data: null, error: null })
    mockFrom.mockReturnValue(chain)

    await replaceBeliefContent('j1', 'updated content', true)

    expect(chain.update).toHaveBeenCalled()
    const updateCall = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateCall.content).toBe('updated content')
    expect(updateCall.confirm_count).toBe(1)
    expect(updateCall.conflict_count).toBe(0)
  })

  it('preserves counts when resetCounts is false', async () => {
    const chain = chainable({ data: null, error: null })
    mockFrom.mockReturnValue(chain)

    await replaceBeliefContent('j1', 'updated content', false)

    const updateCall = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateCall.content).toBe('updated content')
    expect(updateCall.confirm_count).toBeUndefined()
  })
})

describe('markStaleByConversation', () => {
  it('marks entries stale by conversation_id scope_ref', async () => {
    const chain = chainable({ data: null, error: null })
    mockFrom.mockReturnValue(chain)

    await markStaleByConversation('conv-123')

    expect(chain.update).toHaveBeenCalledWith({ is_stale: true, updated_at: expect.any(String) })
    expect(chain.eq).toHaveBeenCalledWith('scope', 'conversation_id')
    expect(chain.eq).toHaveBeenCalledWith('scope_ref', 'conv-123')
  })
})

describe('expireTemporalEntries', () => {
  it('marks expired temporal entries as stale', async () => {
    const chain = chainable({ data: [{ id: '1' }, { id: '2' }], error: null })
    mockFrom.mockReturnValue(chain)

    const count = await expireTemporalEntries()

    expect(chain.update).toHaveBeenCalledWith({ is_stale: true, updated_at: expect.any(String) })
    expect(chain.eq).toHaveBeenCalledWith('scope', 'temporal')
    expect(chain.eq).toHaveBeenCalledWith('is_stale', false)
    // Should filter by expires_at <= now
    expect(chain.lte).toHaveBeenCalled()
    expect(count).toBe(2)
  })

  it('returns 0 when no entries expired', async () => {
    const chain = chainable({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    const count = await expireTemporalEntries()
    expect(count).toBe(0)
  })
})

describe('deleteJournalEntry', () => {
  it('deletes entry by id', async () => {
    const chain = chainable({ data: null, error: null })
    mockFrom.mockReturnValue(chain)

    await deleteJournalEntry('j1')

    expect(mockFrom).toHaveBeenCalledWith('journal_entries')
    expect(chain.delete).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('id', 'j1')
  })
})

describe('createJournalEntries', () => {
  it('bulk inserts entries', async () => {
    const entries = [
      { user_id: 'u1', scope: 'global', topic: 't1', content: 'c1' },
      { user_id: 'u1', scope: 'global', topic: 't2', content: 'c2' },
    ]
    const chain = chainable({ data: entries, error: null })
    mockFrom.mockReturnValue(chain)

    const result = await createJournalEntries(entries)

    expect(chain.insert).toHaveBeenCalledWith(entries)
    expect(result).toEqual(entries)
  })
})
