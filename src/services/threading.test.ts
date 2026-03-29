/**
 * Layer 2: Threading Behavior Pinning
 *
 * Pins the exact similarity thresholds, cosine similarity math, and
 * decision flow for timeline-based conversation assignment.
 *
 * Algorithm: external thread ID → CP conversation count → density heuristic → AI assignment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cosineSimilarity, SIMILARITY_THRESHOLD, TIEBREAKER_THRESHOLD } from './threading'

// ── Mock all external dependencies ──────────────────────────────────────────
vi.mock('@/lib/db/conversations', () => ({
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  updateConversationSummary: vi.fn(),
  incrementMessageCount: vi.fn(),
  addParticipant: vi.fn(),
  findConversationByExternalThread: vi.fn(),
  getRecentMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/messages', () => ({
  updateMessage: vi.fn(),
  getMessageById: vi.fn(),
}))

vi.mock('@/lib/db/counterparties', () => ({
  getCPById: vi.fn(),
}))

vi.mock('@/lib/ai/gemini', () => ({
  analyzeConversation: vi.fn(),
  extractTopic: vi.fn().mockResolvedValue('Test topic'),
  shouldJoinConversation: vi.fn(),
}))

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn().mockResolvedValue('NEW'),
}))

vi.mock('@/lib/embeddings/generate', () => ({
  generateConversationEmbedding: vi.fn(),
  generateMessageEmbedding: vi.fn(),
}))

vi.mock('@/lib/db/embeddings', () => ({
  saveConversationEmbedding: vi.fn(),
  getConversationsWithEmbeddingsByCP: vi.fn(),
}))

vi.mock('@/lib/db/timeline', () => ({
  assignTimelineEntry: vi.fn(),
  getRecentDensityByConversation: vi.fn().mockResolvedValue(new Map()),
  getTimelineContextForConversations: vi.fn().mockResolvedValue(new Map()),
}))

vi.mock('@/lib/db/todos', () => ({
  createTodo: vi.fn(),
}))

vi.mock('@/lib/db/users', () => ({
  getUserSettings: vi.fn(),
}))

vi.mock('@/shared/deal-types', () => ({
  validateDealType: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            data: [],
            error: null,
          }),
          in: () => ({
            eq: () => ({
              data: [],
              error: null,
            }),
          }),
        }),
      }),
    }),
  }),
}))

vi.mock('uuid', () => ({
  v4: () => '00000000-0000-4000-a000-000000000099',
}))

// ── Threshold Constant Pinning ──────────────────────────────────────────────

describe('Threading — Threshold Pinning', () => {
  it('auto-join threshold is exactly 0.78', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.78)
  })

  it('AI tiebreaker threshold is exactly 0.55', () => {
    expect(TIEBREAKER_THRESHOLD).toBe(0.55)
  })

  it('auto-join threshold is strictly greater than tiebreaker threshold', () => {
    expect(SIMILARITY_THRESHOLD).toBeGreaterThan(TIEBREAKER_THRESHOLD)
  })

  it('tiebreaker threshold is strictly greater than 0 (never matches everything)', () => {
    expect(TIEBREAKER_THRESHOLD).toBeGreaterThan(0)
  })
})

// ── Cosine Similarity Pinning ───────────────────────────────────────────────

describe('Threading — Cosine Similarity Pinning', () => {
  it('identical vectors return exactly 1.0', () => {
    const v = [1, 2, 3, 4, 5]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
  })

  it('orthogonal vectors return exactly 0.0', () => {
    // [1, 0] · [0, 1] = 0
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('opposite vectors return exactly -1.0', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10)
  })

  it('known vectors produce exact numeric result', () => {
    // [3, 4] · [4, 3] = 12 + 12 = 24
    // ||[3,4]|| = 5, ||[4,3]|| = 5
    // similarity = 24 / 25 = 0.96
    expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96, 10)
  })

  it('different-length vectors return 0', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
  })

  it('zero vector returns 0', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0)
  })

  it('both zero vectors return 0', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })

  it('empty vectors return 0', () => {
    expect(cosineSimilarity([], [])).toBeCloseTo(0, 10)
  })

  it('scaling a vector does not change similarity', () => {
    const a = [1, 2, 3]
    const b = [4, 5, 6]
    const bScaled = [8, 10, 12] // b × 2
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(a, bScaled), 10)
  })
})

// ── Timeline-Based Decision Flow Pinning ──────────────────────────────────

describe('Threading — Decision Flow Pinning', () => {
  let findConversationByExternalThread: ReturnType<typeof vi.fn>
  let getMessageById: ReturnType<typeof vi.fn>
  let updateMessage: ReturnType<typeof vi.fn>
  let incrementMessageCount: ReturnType<typeof vi.fn>
  let addParticipant: ReturnType<typeof vi.fn>
  let getConversationById: ReturnType<typeof vi.fn>
  let createConversation: ReturnType<typeof vi.fn>
  let assignTimelineEntry: ReturnType<typeof vi.fn>
  let getRecentDensityByConversation: ReturnType<typeof vi.fn>
  let getTimelineContextForConversations: ReturnType<typeof vi.fn>
  let runAITask: ReturnType<typeof vi.fn>
  let getCPById: ReturnType<typeof vi.fn>
  let createTodo: ReturnType<typeof vi.fn>
  let getSupabaseAdmin: ReturnType<typeof vi.fn>
  let assignToConversation: Awaited<typeof import('./threading')>['assignToConversation']

  const FAKE_CONV = {
    id: 'conv-1',
    user_id: 'user-1',
    topic: 'Test deal',
    state: 'active',
    messages_since_rebuild: 0,
  }

  const baseEntry = {
    id: 'entry-1',
    user_id: 'user-1',
    cp_id: 'cp-1',
    conversation_id: null as string | null,
    parent_id: null,
    event_type: 'email',
    direction: 'in',
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    content: 'This is a test email with enough content to pass the thin conversation threshold check which requires more than one hundred characters of text',
    message_id: 'msg-1' as string | null,
    metadata: null,
  }

  beforeEach(async () => {
    vi.clearAllMocks()

    const convDb = await import('@/lib/db/conversations')
    const msgDb = await import('@/lib/db/messages')
    const cpDb = await import('@/lib/db/counterparties')
    const timelineDb = await import('@/lib/db/timeline')
    const aiRunner = await import('@/lib/ai/runner')
    const todoDb = await import('@/lib/db/todos')
    const supabaseClient = await import('@/lib/supabase/client')
    const threading = await import('./threading')

    findConversationByExternalThread = vi.mocked(convDb.findConversationByExternalThread)
    getMessageById = vi.mocked(msgDb.getMessageById)
    updateMessage = vi.mocked(msgDb.updateMessage)
    incrementMessageCount = vi.mocked(convDb.incrementMessageCount)
    addParticipant = vi.mocked(convDb.addParticipant)
    getConversationById = vi.mocked(convDb.getConversationById)
    createConversation = vi.mocked(convDb.createConversation)
    assignTimelineEntry = vi.mocked(timelineDb.assignTimelineEntry)
    getRecentDensityByConversation = vi.mocked(timelineDb.getRecentDensityByConversation)
    getTimelineContextForConversations = vi.mocked(timelineDb.getTimelineContextForConversations)
    runAITask = vi.mocked(aiRunner.runAITask)
    getCPById = vi.mocked(cpDb.getCPById)
    createTodo = vi.mocked(todoDb.createTodo)
    getSupabaseAdmin = vi.mocked(supabaseClient.getSupabaseAdmin)
    assignToConversation = threading.assignToConversation

    getConversationById.mockResolvedValue(FAKE_CONV)
    getMessageById.mockResolvedValue(null)
  })

  it('external thread ID match joins existing conversation via message_id lookup', async () => {
    const entry = { ...baseEntry, message_id: 'msg-1' }

    // message_id lookup returns a message with external_thread_id
    getMessageById.mockResolvedValue({
      id: 'msg-1',
      external_thread_id: 'thread-gmail-123',
    })
    findConversationByExternalThread.mockResolvedValue(FAKE_CONV)

    const result = await assignToConversation(entry as any)

    expect(getMessageById).toHaveBeenCalledWith('msg-1')
    expect(findConversationByExternalThread).toHaveBeenCalledWith('user-1', 'thread-gmail-123')
    expect(assignTimelineEntry).toHaveBeenCalledWith('entry-1', 'conv-1')
    expect(updateMessage).toHaveBeenCalledWith('msg-1', { conversation_id: 'conv-1' })
    expect(incrementMessageCount).toHaveBeenCalledWith('conv-1')
    expect(result.id).toBe('conv-1')
  })

  it('entry without message_id skips external thread ID lookup', async () => {
    const entry = { ...baseEntry, message_id: null }

    // No CP conversations exist → create new
    const newConv = { ...FAKE_CONV, id: 'conv-new' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    const result = await assignToConversation(entry as any)

    expect(getMessageById).not.toHaveBeenCalled()
    expect(findConversationByExternalThread).not.toHaveBeenCalled()
    expect(createConversation).toHaveBeenCalled()
    expect(result.id).toBe('conv-new')
  })

  it('zero CP conversations creates new conversation', async () => {
    const entry = { ...baseEntry, message_id: null }

    // Supabase returns no thread_participants for this CP
    const newConv = { ...FAKE_CONV, id: 'conv-new' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    const result = await assignToConversation(entry as any)

    expect(createConversation).toHaveBeenCalled()
    expect(result.id).toBe('conv-new')
  })

  it('one CP conversation assigns directly without AI', async () => {
    const entry = { ...baseEntry, message_id: null }

    // Mock supabase to return one active conversation for this CP
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'thread_participants') {
        return {
          select: () => ({
            eq: () => ({
              data: [{ thread_id: 'conv-1' }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'conversation_threads') {
        return {
          select: () => ({
            eq: vi.fn().mockReturnValue({
              in: () => ({
                eq: () => ({
                  data: [{ id: 'conv-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ data: [], error: null }) }) }
    })
    getSupabaseAdmin.mockReturnValue({ from: mockFrom } as any)

    const result = await assignToConversation(entry as any)

    // Should assign directly — no AI, no density check
    expect(assignTimelineEntry).toHaveBeenCalledWith('entry-1', 'conv-1')
    expect(runAITask).not.toHaveBeenCalled()
    expect(result.id).toBe('conv-1')
  })

  it('multiple conversations with density burst assigns to active conversation', async () => {
    const entry = { ...baseEntry, message_id: null }

    // Mock supabase to return two active conversations
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'thread_participants') {
        return {
          select: () => ({
            eq: () => ({
              data: [{ thread_id: 'conv-1' }, { thread_id: 'conv-2' }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'conversation_threads') {
        return {
          select: () => ({
            eq: vi.fn().mockReturnValue({
              in: () => ({
                eq: () => ({
                  data: [{ id: 'conv-1' }, { id: 'conv-2' }],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ data: [], error: null }) }) }
    })
    getSupabaseAdmin.mockReturnValue({ from: mockFrom } as any)

    // Density: conv-1 has 5 recent entries, conv-2 has 0
    getRecentDensityByConversation.mockResolvedValue(new Map([
      ['conv-1', 5],
    ]))

    const result = await assignToConversation(entry as any)

    // Should assign to conv-1 (density winner) without AI
    expect(assignTimelineEntry).toHaveBeenCalledWith('entry-1', 'conv-1')
    expect(runAITask).not.toHaveBeenCalled()
    expect(result.id).toBe('conv-1')
  })

  it('multiple conversations without clear density winner falls through to AI', async () => {
    const entry = { ...baseEntry, message_id: null }

    // Mock supabase to return two active conversations
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'thread_participants') {
        return {
          select: () => ({
            eq: () => ({
              data: [{ thread_id: 'conv-1' }, { thread_id: 'conv-2' }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'conversation_threads') {
        return {
          select: () => ({
            eq: vi.fn().mockReturnValue({
              in: () => ({
                eq: () => ({
                  data: [{ id: 'conv-1' }, { id: 'conv-2' }],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ data: [], error: null }) }) }
    })
    getSupabaseAdmin.mockReturnValue({ from: mockFrom } as any)

    // No clear density winner (both have similar counts)
    getRecentDensityByConversation.mockResolvedValue(new Map([
      ['conv-1', 1],
      ['conv-2', 1],
    ]))

    // AI picks conv-2
    getConversationById.mockImplementation(async (id: string) => {
      if (id === 'conv-1') return { ...FAKE_CONV, id: 'conv-1', topic: 'Deal A' }
      if (id === 'conv-2') return { ...FAKE_CONV, id: 'conv-2', topic: 'Deal B' }
      return FAKE_CONV
    })
    getTimelineContextForConversations.mockResolvedValue(new Map())
    runAITask.mockResolvedValue('conv-2')

    const result = await assignToConversation(entry as any)

    expect(runAITask).toHaveBeenCalled()
    expect(assignTimelineEntry).toHaveBeenCalledWith('entry-1', 'conv-2')
    expect(result.id).toBe('conv-2')
  })

  it('AI returning NEW creates a new conversation', async () => {
    const entry = { ...baseEntry, message_id: null }

    // Mock supabase to return two active conversations
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'thread_participants') {
        return {
          select: () => ({
            eq: () => ({
              data: [{ thread_id: 'conv-1' }, { thread_id: 'conv-2' }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'conversation_threads') {
        return {
          select: () => ({
            eq: vi.fn().mockReturnValue({
              in: () => ({
                eq: () => ({
                  data: [{ id: 'conv-1' }, { id: 'conv-2' }],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ data: [], error: null }) }) }
    })
    getSupabaseAdmin.mockReturnValue({ from: mockFrom } as any)

    getRecentDensityByConversation.mockResolvedValue(new Map())
    getConversationById.mockImplementation(async (id: string) => {
      if (id === 'conv-1') return { ...FAKE_CONV, id: 'conv-1' }
      if (id === 'conv-2') return { ...FAKE_CONV, id: 'conv-2' }
      if (id === 'conv-new') return { ...FAKE_CONV, id: 'conv-new' }
      return FAKE_CONV
    })
    getTimelineContextForConversations.mockResolvedValue(new Map())
    runAITask.mockResolvedValue('NEW')

    const newConv = { ...FAKE_CONV, id: 'conv-new' }
    createConversation.mockResolvedValue(newConv)

    const result = await assignToConversation(entry as any)

    expect(runAITask).toHaveBeenCalled()
    expect(createConversation).toHaveBeenCalled()
    expect(result.id).toBe('conv-new')
  })

  // ── Thin conversation ToDo pinning ────────────────────────────────────────

  it('short content creates thin-conversation ToDo', async () => {
    const entry = {
      ...baseEntry,
      message_id: null,
      content: 'Short',  // < 100 chars
    }

    const newConv = { ...FAKE_CONV, id: 'conv-thin' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)
    getCPById.mockResolvedValue({ name: 'Thin CP', primary_identifier: 'thin@test.com' })

    await assignToConversation(entry as any)

    expect(createTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        cp_id: 'cp-1',
        thread_id: 'conv-thin',
        status: 'pending',
      })
    )
  })

  it('empty content does NOT create thin-conversation ToDo', async () => {
    const entry = {
      ...baseEntry,
      message_id: null,
      content: '',  // empty
    }

    const newConv = { ...FAKE_CONV, id: 'conv-empty' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    await assignToConversation(entry as any)

    expect(createTodo).not.toHaveBeenCalled()
  })

  it('null content does NOT create thin-conversation ToDo', async () => {
    const entry = {
      ...baseEntry,
      message_id: null,
      content: null,
    }

    const newConv = { ...FAKE_CONV, id: 'conv-null' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    await assignToConversation(entry as any)

    expect(createTodo).not.toHaveBeenCalled()
  })

  it('long content does NOT create thin-conversation ToDo', async () => {
    const entry = {
      ...baseEntry,
      message_id: null,
      // content already > 100 chars from baseEntry
    }

    const newConv = { ...FAKE_CONV, id: 'conv-long' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    await assignToConversation(entry as any)

    expect(createTodo).not.toHaveBeenCalled()
  })
})
