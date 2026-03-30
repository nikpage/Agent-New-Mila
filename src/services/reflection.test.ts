import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('@/lib/db/journal', () => ({
  getRecentJournalEntries: vi.fn().mockResolvedValue([]),
  findMatchingEntry: vi.fn().mockResolvedValue(null),
  createJournalEntry: vi.fn().mockImplementation(async (entry) => ({ id: 'new-1', ...entry })),
  confirmObservation: vi.fn().mockImplementation(async (id) => ({ id, confirm_count: 2 })),
  recordConflict: vi.fn().mockImplementation(async (id) => ({ id, conflict_count: 1 })),
}))

vi.mock('@/lib/db/actions', () => ({
  getActionsForUser: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/counterparties', () => ({
  getCPById: vi.fn().mockResolvedValue({ id: 'cp-1', name: 'Jan Novak' }),
}))

vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn().mockResolvedValue({ id: 'user-1', settings: { ai_language: 'cs', last_reflection_at: null } }),
  getUserSettings: vi.fn().mockResolvedValue({ ai_language: 'cs', last_reflection_at: null }),
}))

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn().mockResolvedValue('{"observations":[],"abstain_reason":"nothing notable"}'),
}))

// Chainable Supabase mock for reflection's direct queries
function chainableSb(finalResult: { data: unknown; error: unknown } = { data: [], error: null }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'in', 'gte', 'order', 'limit', 'single', 'maybeSingle', 'or']
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(finalResult)
  return chain
}

const mockSupabaseFrom = vi.fn().mockReturnValue(chainableSb())
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue({ from: (...args: unknown[]) => mockSupabaseFrom(...args) }),
}))

import { processReflectionOutput, gatherReflectionInput, runReflection } from './reflection'
import { findMatchingEntry, createJournalEntry, confirmObservation, recordConflict, getRecentJournalEntries } from '@/lib/db/journal'
import { runAITask } from '@/lib/ai/runner'
import type { JournalEntry } from '@/lib/supabase/types'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('processReflectionOutput', () => {
  it('creates new entries for "new" observations', async () => {
    const output = {
      observations: [
        {
          scope: 'global' as const,
          scope_ref: null,
          topic: 'reply style',
          content: 'User prefers short direct replies',
          expires_at: null,
          relation_to_existing: 'new' as const,
          existing_topic_match: null,
        },
      ],
      abstain_reason: null,
    }

    const result = await processReflectionOutput('user-1', output)

    expect(createJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1',
      scope: 'global',
      scope_ref: null,
      topic: 'reply style',
      content: 'User prefers short direct replies',
      type: 'observation',
    }))
    expect(result.created).toBe(1)
    expect(result.confirmed).toBe(0)
    expect(result.conflicted).toBe(0)
  })

  it('confirms matching entry for "confirming" observations', async () => {
    const existingEntry = { id: 'j-existing', topic: 'reply style', confirm_count: 1, type: 'observation' } as JournalEntry
    vi.mocked(findMatchingEntry).mockResolvedValueOnce(existingEntry)

    const output = {
      observations: [
        {
          scope: 'global' as const,
          scope_ref: null,
          topic: 'reply style',
          content: 'User prefers short replies',
          expires_at: null,
          relation_to_existing: 'confirming' as const,
          existing_topic_match: 'reply style',
        },
      ],
      abstain_reason: null,
    }

    const result = await processReflectionOutput('user-1', output)

    expect(confirmObservation).toHaveBeenCalledWith('j-existing')
    expect(result.confirmed).toBe(1)
    expect(result.created).toBe(0)
  })

  it('records conflict for "contradicting" observations', async () => {
    const existingEntry = { id: 'j-existing', topic: 'tone', conflict_count: 0, type: 'belief' } as JournalEntry
    vi.mocked(findMatchingEntry).mockResolvedValueOnce(existingEntry)

    const output = {
      observations: [
        {
          scope: 'global' as const,
          scope_ref: null,
          topic: 'tone',
          content: 'User now uses informal tone',
          expires_at: null,
          relation_to_existing: 'contradicting' as const,
          existing_topic_match: 'tone',
        },
      ],
      abstain_reason: null,
    }

    const result = await processReflectionOutput('user-1', output)

    expect(recordConflict).toHaveBeenCalledWith('j-existing')
    expect(result.conflicted).toBe(1)
  })

  it('falls back to creating new entry when confirming but no match found', async () => {
    vi.mocked(findMatchingEntry).mockResolvedValueOnce(null)

    const output = {
      observations: [
        {
          scope: 'global' as const,
          scope_ref: null,
          topic: 'missing topic',
          content: 'Some observation',
          expires_at: null,
          relation_to_existing: 'confirming' as const,
          existing_topic_match: 'missing topic',
        },
      ],
      abstain_reason: null,
    }

    const result = await processReflectionOutput('user-1', output)

    // Should fall back to creating new since match wasn't found
    expect(createJournalEntry).toHaveBeenCalled()
    expect(result.created).toBe(1)
  })

  it('handles empty observations (abstain)', async () => {
    const output = {
      observations: [],
      abstain_reason: 'No notable patterns in this cycle',
    }

    const result = await processReflectionOutput('user-1', output)

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(confirmObservation).not.toHaveBeenCalled()
    expect(recordConflict).not.toHaveBeenCalled()
    expect(result.created).toBe(0)
    expect(result.confirmed).toBe(0)
    expect(result.conflicted).toBe(0)
  })

  it('sets expires_at for temporal entries', async () => {
    const output = {
      observations: [
        {
          scope: 'temporal' as const,
          scope_ref: 'conv-1',
          topic: 'deadline',
          content: 'Bank deadline April 15',
          expires_at: '2026-04-15T23:59:59Z',
          relation_to_existing: 'new' as const,
          existing_topic_match: null,
        },
      ],
      abstain_reason: null,
    }

    await processReflectionOutput('user-1', output)

    expect(createJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'temporal',
      expires_at: '2026-04-15T23:59:59Z',
    }))
  })

  it('processes multiple observations in one output', async () => {
    const existingEntry = { id: 'j-existing', topic: 'response time', confirm_count: 2, type: 'observation' } as JournalEntry
    // Only the "confirming" observation calls findMatchingEntry — "new" goes straight to create
    vi.mocked(findMatchingEntry)
      .mockResolvedValueOnce(existingEntry)  // confirming obs: match → confirm

    const output = {
      observations: [
        {
          scope: 'global' as const,
          scope_ref: null,
          topic: 'editing pattern',
          content: 'User always adds a greeting line',
          expires_at: null,
          relation_to_existing: 'new' as const,
          existing_topic_match: null,
        },
        {
          scope: 'cp_id' as const,
          scope_ref: 'cp-1',
          topic: 'response time',
          content: 'CP responds within 2 hours',
          expires_at: null,
          relation_to_existing: 'confirming' as const,
          existing_topic_match: 'response time',
        },
      ],
      abstain_reason: null,
    }

    const result = await processReflectionOutput('user-1', output)

    expect(result.created).toBe(1)
    expect(result.confirmed).toBe(1)
  })
})

describe('gatherReflectionInput', () => {
  it('returns empty arrays when no actions or timeline changes', async () => {
    // Supabase mock already returns empty arrays by default
    vi.mocked(getRecentJournalEntries).mockResolvedValue([])

    const input = await gatherReflectionInput('user-1')

    expect(input.actedOnActions).toEqual([])
    expect(input.recentJournalEntries).toEqual([])
  })

  it('collects acted-on actions with original vs final comparison data', async () => {
    const actionData = [
      {
        id: 'a1',
        action_type: 'REPLY',
        cp_id: 'cp-1',
        original_intent_cs: 'Original intent',
        intent_cs: 'Modified intent',
        original_draft_body: 'Original draft',
        draft_body_text: 'Modified draft',
        status: 'completed',
        payload: { userNotes: 'some notes', editedTo: null },
      },
    ]

    // First from() call is for action_proposals, second for deal_timeline
    let callCount = 0
    mockSupabaseFrom.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return chainableSb({ data: actionData, error: null })
      }
      return chainableSb({ data: [], error: null })
    })

    vi.mocked(getRecentJournalEntries).mockResolvedValue([])

    const input = await gatherReflectionInput('user-1')

    expect(input.actedOnActions).toHaveLength(1)
    expect(input.actedOnActions[0]).toMatchObject({
      actionId: 'a1',
      actionType: 'REPLY',
      originalIntentCs: 'Original intent',
      finalIntentCs: 'Modified intent',
      originalDraftBody: 'Original draft',
      finalDraftBody: 'Modified draft',
      userAction: 'completed',
    })
  })
})

describe('runReflection', () => {
  it('calls AI with reflection stage', async () => {
    vi.mocked(runAITask).mockResolvedValue(JSON.stringify({
      observations: [],
      abstain_reason: 'nothing notable',
    }))

    const result = await runReflection('user-1')

    expect(runAITask).toHaveBeenCalledWith('reflection', expect.any(String))
    expect(result.observationsWritten).toBe(0)
  })

  it('handles AI returning valid observations', async () => {
    vi.mocked(runAITask).mockResolvedValue(JSON.stringify({
      observations: [
        {
          scope: 'global',
          scope_ref: null,
          topic: 'test pattern',
          content: 'User does X',
          expires_at: null,
          relation_to_existing: 'new',
          existing_topic_match: null,
        },
      ],
      abstain_reason: null,
    }))

    const result = await runReflection('user-1')

    expect(result.observationsWritten).toBe(1)
  })

  it('handles malformed AI response gracefully', async () => {
    vi.mocked(runAITask).mockResolvedValue('not valid json at all')

    const result = await runReflection('user-1')

    expect(result.observationsWritten).toBe(0)
    expect(result.error).toBeDefined()
  })

  it('handles AI throwing an error', async () => {
    vi.mocked(runAITask).mockRejectedValue(new Error('AI service down'))

    const result = await runReflection('user-1')

    expect(result.observationsWritten).toBe(0)
    expect(result.error).toBeDefined()
  })
})
