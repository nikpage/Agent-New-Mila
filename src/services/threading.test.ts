/**
 * Layer 2: Threading Behavior Pinning
 *
 * Pins the exact similarity thresholds, cosine similarity math, and
 * decision flow (external thread ID → embedding → new conversation).
 * If someone changes these values or the branching logic, these tests fail.
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

vi.mock('@/lib/embeddings/generate', () => ({
  generateConversationEmbedding: vi.fn(),
  generateMessageEmbedding: vi.fn(),
}))

vi.mock('@/lib/db/embeddings', () => ({
  saveConversationEmbedding: vi.fn(),
  getConversationsWithEmbeddingsByCP: vi.fn(),
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

// ── Threading Decision Flow Pinning ─────────────────────────────────────────

describe('Threading — Decision Flow Pinning', () => {
  // Grab mocked modules for per-test control
  let findConversationByExternalThread: ReturnType<typeof vi.fn>
  let updateMessage: ReturnType<typeof vi.fn>
  let incrementMessageCount: ReturnType<typeof vi.fn>
  let addParticipant: ReturnType<typeof vi.fn>
  let getConversationById: ReturnType<typeof vi.fn>
  let createConversation: ReturnType<typeof vi.fn>
  let generateMessageEmbedding: ReturnType<typeof vi.fn>
  let getConversationsWithEmbeddingsByCP: ReturnType<typeof vi.fn>
  let shouldJoinConversation: ReturnType<typeof vi.fn>
  let getCPById: ReturnType<typeof vi.fn>
  let createTodo: ReturnType<typeof vi.fn>
  let assignToConversation: Awaited<typeof import('./threading')>['assignToConversation']

  const FAKE_CONV = {
    id: 'conv-1',
    user_id: 'user-1',
    topic: 'Test',
    state: 'active',
    messages_since_rebuild: 0,
  }

  const baseMessage = {
    id: 'msg-1',
    user_id: 'user-1',
    cp_id: 'cp-1',
    external_thread_id: null as string | null,
    enriched_text: 'Enriched text for testing that is definitely longer than one hundred characters so that we can test the thin conversation threshold properly and completely',
    cleaned_text: 'cleaned text',
    raw_text: 'raw text',
    tag_primary: null as string | null,
    conversation_id: null,
    channel_id: 'email',
    direction: 'inbound',
    timestamp: new Date().toISOString(),
  }

  beforeEach(async () => {
    vi.clearAllMocks()

    // Dynamic import to get mocked versions
    const convDb = await import('@/lib/db/conversations')
    const msgDb = await import('@/lib/db/messages')
    const cpDb = await import('@/lib/db/counterparties')
    const embedDb = await import('@/lib/db/embeddings')
    const ai = await import('@/lib/ai/gemini')
    const embedGen = await import('@/lib/embeddings/generate')
    const todoDb = await import('@/lib/db/todos')
    const threading = await import('./threading')

    findConversationByExternalThread = vi.mocked(convDb.findConversationByExternalThread)
    updateMessage = vi.mocked(msgDb.updateMessage)
    incrementMessageCount = vi.mocked(convDb.incrementMessageCount)
    addParticipant = vi.mocked(convDb.addParticipant)
    getConversationById = vi.mocked(convDb.getConversationById)
    createConversation = vi.mocked(convDb.createConversation)
    generateMessageEmbedding = vi.mocked(embedGen.generateMessageEmbedding)
    getConversationsWithEmbeddingsByCP = vi.mocked(embedDb.getConversationsWithEmbeddingsByCP)
    shouldJoinConversation = vi.mocked(ai.shouldJoinConversation)
    getCPById = vi.mocked(cpDb.getCPById)
    createTodo = vi.mocked(todoDb.createTodo)
    assignToConversation = threading.assignToConversation

    // Default: getConversationById returns the fake conversation
    getConversationById.mockResolvedValue(FAKE_CONV)
  })

  it('external thread ID match joins existing conversation without embedding check', async () => {
    const message = { ...baseMessage, external_thread_id: 'thread-gmail-123' }

    findConversationByExternalThread.mockResolvedValue(FAKE_CONV)

    const result = await assignToConversation(message as any)

    expect(findConversationByExternalThread).toHaveBeenCalledWith('user-1', 'thread-gmail-123')
    expect(updateMessage).toHaveBeenCalledWith('msg-1', { conversation_id: 'conv-1' })
    expect(incrementMessageCount).toHaveBeenCalledWith('conv-1')
    // Embedding should NOT have been called
    expect(generateMessageEmbedding).not.toHaveBeenCalled()
    expect(result.id).toBe('conv-1')
  })

  it('high similarity (≥ 0.78) auto-joins without AI tiebreak', async () => {
    const message = { ...baseMessage, external_thread_id: null }

    findConversationByExternalThread.mockResolvedValue(null)

    // Return an embedding that will produce high similarity
    const fakeEmbedding = [1, 0, 0]
    generateMessageEmbedding.mockResolvedValue(fakeEmbedding)

    // Return a candidate with identical embedding (similarity = 1.0 > 0.78)
    getConversationsWithEmbeddingsByCP.mockResolvedValue([
      { id: 'conv-1', embedding: [1, 0, 0] },
    ])

    const result = await assignToConversation(message as any)

    expect(updateMessage).toHaveBeenCalledWith('msg-1', { conversation_id: 'conv-1' })
    // AI tiebreaker should NOT be called
    expect(shouldJoinConversation).not.toHaveBeenCalled()
    expect(result.id).toBe('conv-1')
  })

  it('mid similarity (0.55–0.78) calls AI tiebreaker', async () => {
    const message = { ...baseMessage, external_thread_id: null }

    findConversationByExternalThread.mockResolvedValue(null)

    // Craft vectors with cosine similarity ~0.65 (between 0.55 and 0.78)
    // cos(θ) = 0.65 → use vectors [1, 0] and [0.65, sqrt(1-0.65²)]
    const msgEmb = [1, 0]
    const candEmb = [0.65, Math.sqrt(1 - 0.65 * 0.65)]
    generateMessageEmbedding.mockResolvedValue(msgEmb)
    getConversationsWithEmbeddingsByCP.mockResolvedValue([
      { id: 'conv-1', embedding: candEmb },
    ])
    getCPById.mockResolvedValue({ name: 'Test CP', primary_identifier: 'test@test.com' })

    // AI says: yes, join
    shouldJoinConversation.mockResolvedValue(true)

    const result = await assignToConversation(message as any)

    expect(shouldJoinConversation).toHaveBeenCalled()
    expect(updateMessage).toHaveBeenCalledWith('msg-1', { conversation_id: 'conv-1' })
    expect(result.id).toBe('conv-1')
  })

  it('low similarity (< 0.55) creates new conversation', async () => {
    const message = { ...baseMessage, external_thread_id: null }

    findConversationByExternalThread.mockResolvedValue(null)

    // Craft vectors with low similarity (orthogonal ≈ 0)
    generateMessageEmbedding.mockResolvedValue([1, 0])
    getConversationsWithEmbeddingsByCP.mockResolvedValue([
      { id: 'conv-other', embedding: [0, 1] }, // similarity = 0
    ])

    const newConv = { ...FAKE_CONV, id: 'conv-new' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    const result = await assignToConversation(message as any)

    // Should NOT have tried to join anything
    expect(shouldJoinConversation).not.toHaveBeenCalled()
    // Should have created a new conversation
    expect(createConversation).toHaveBeenCalled()
    expect(result.id).toBe('conv-new')
  })

  it('message without cp_id skips embedding and creates new conversation', async () => {
    const message = { ...baseMessage, cp_id: null, external_thread_id: null }

    findConversationByExternalThread.mockResolvedValue(null)

    const newConv = { ...FAKE_CONV, id: 'conv-no-cp' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    const result = await assignToConversation(message as any)

    expect(generateMessageEmbedding).not.toHaveBeenCalled()
    expect(getConversationsWithEmbeddingsByCP).not.toHaveBeenCalled()
    expect(createConversation).toHaveBeenCalled()
    expect(result.id).toBe('conv-no-cp')
  })

  // ── tag_primary read-behavior pinning ───────────────────────────────────

  it('tag_primary=bulk_import suppresses thin-conversation ToDo', async () => {
    const message = {
      ...baseMessage,
      external_thread_id: null,
      cp_id: 'cp-1',
      tag_primary: 'bulk_import',
      enriched_text: 'Short', // < 100 chars — would trigger ToDo normally
    }

    findConversationByExternalThread.mockResolvedValue(null)
    generateMessageEmbedding.mockRejectedValue(new Error('no embedding'))

    const newConv = { ...FAKE_CONV, id: 'conv-bulk' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)
    getCPById.mockResolvedValue({ name: 'Bulk CP', primary_identifier: 'bulk@test.com' })

    await assignToConversation(message as any)

    // ToDo should NOT be created for bulk_import messages
    expect(createTodo).not.toHaveBeenCalled()
  })

  it('short enriched_text without bulk_import DOES create thin-conversation ToDo', async () => {
    const message = {
      ...baseMessage,
      external_thread_id: null,
      cp_id: 'cp-1',
      tag_primary: null,
      enriched_text: 'Short', // < 100 chars
    }

    findConversationByExternalThread.mockResolvedValue(null)
    generateMessageEmbedding.mockRejectedValue(new Error('no embedding'))

    const newConv = { ...FAKE_CONV, id: 'conv-thin' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)
    getCPById.mockResolvedValue({ name: 'Thin CP', primary_identifier: 'thin@test.com' })

    await assignToConversation(message as any)

    // ToDo SHOULD be created
    expect(createTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        cp_id: 'cp-1',
        thread_id: 'conv-thin',
        status: 'pending',
      })
    )
  })

  it('null enriched_text does NOT create thin-conversation ToDo (not enriched ≠ thin)', async () => {
    const message = {
      ...baseMessage,
      external_thread_id: null,
      cp_id: 'cp-1',
      tag_primary: null,
      enriched_text: null,
    }

    findConversationByExternalThread.mockResolvedValue(null)
    generateMessageEmbedding.mockRejectedValue(new Error('no embedding'))

    const newConv = { ...FAKE_CONV, id: 'conv-no-enrich' }
    createConversation.mockResolvedValue(newConv)
    getConversationById.mockResolvedValue(newConv)

    await assignToConversation(message as any)

    // No ToDo — null enriched_text means enrichment didn't run
    expect(createTodo).not.toHaveBeenCalled()
  })
})
