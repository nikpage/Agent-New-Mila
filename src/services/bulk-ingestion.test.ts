import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track call order to verify phase sequencing
const callOrder: string[] = []

// Mock all external dependencies
vi.mock('@/lib/google/gmail', () => ({
  fetchEmailsPaginated: vi.fn().mockResolvedValue([]),
  extractEmailAddress: vi.fn((s: string) => s),
  extractName: vi.fn(() => null),
  getUserEmail: vi.fn().mockResolvedValue('test@test.com'),
  GMAIL_SKIP_CATEGORIES: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'],
}))

vi.mock('@/lib/ai/gemini', () => ({
  preFilterEmail: vi.fn().mockResolvedValue({ relevant: true }),
  classifyEmail: vi.fn().mockResolvedValue({
    isActionable: true,
    category: 'question',
    priority: 'medium',
  }),
}))

vi.mock('@/lib/ai/runner', () => ({
  probeAIAvailability: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db/counterparties', () => ({
  findOrCreateCP: vi.fn().mockResolvedValue({ id: 'cp-1' }),
  isSameGmailAddress: vi.fn((a: string, b: string) => a.toLowerCase() === b.toLowerCase()),
  normalizeGmailAddress: vi.fn((email: string) => email.toLowerCase()),
  purgeUserAsCp: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/db/messages', () => ({
  createMessage: vi.fn().mockResolvedValue({}),
  messageExists: vi.fn().mockResolvedValue(false),
  getUnprocessedMessages: vi.fn().mockResolvedValue([]),
  updateMessage: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn().mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    google_oauth_tokens: { access_token: 'token' },
  }),
  upsertUser: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/embeddings/generate', () => ({
  generateMessageEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0)),
}))

vi.mock('@/lib/db/embeddings', () => ({
  saveMessageEmbedding: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    }),
  }),
}))

vi.mock('./ingestion', () => ({
  isBlockedSender: vi.fn().mockReturnValue(false),
}))

vi.mock('./threading', () => ({
  processMessagesForThreading: vi.fn().mockResolvedValue(new Map()),
}))

vi.mock('./backfill-report', () => ({
  generateAndSendBackfillReport: vi.fn().mockImplementation(async () => {
    callOrder.push('phase3_report')
    return { sent: true }
  }),
}))

import { runBulkIngestion } from './bulk-ingestion'
import { classifyEmail } from '@/lib/ai/gemini'
import { updateMessage } from '@/lib/db/messages'
import { generateMessageEmbedding } from '@/lib/embeddings/generate'
import { saveMessageEmbedding } from '@/lib/db/embeddings'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { generateAndSendBackfillReport } from './backfill-report'

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0

  // Reset default mock: no unenriched messages
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    }),
  } as never)
})

describe('runBulkIngestion — Phase 4 enrichment', () => {
  it('Phase 3 report is sent before Phase 4 enrichment starts', async () => {
    // Set up mock to track when classifyEmail is called (Phase 4)
    vi.mocked(classifyEmail).mockImplementation(async () => {
      callOrder.push('phase4_classify')
      return { isActionable: true, category: 'question', priority: 'medium' }
    })

    // Mock: 1 unenriched message exists
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ id: 'msg-1', raw_text: 'Hello', cleaned_text: 'Hello', tag_primary: 'bulk_import' }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as never)

    await runBulkIngestion('user-1', new Date('2024-01-01'))

    // Phase 3 report must come before Phase 4 classify
    const reportIndex = callOrder.indexOf('phase3_report')
    const classifyIndex = callOrder.indexOf('phase4_classify')
    expect(reportIndex).toBeGreaterThanOrEqual(0)
    expect(classifyIndex).toBeGreaterThanOrEqual(0)
    expect(reportIndex).toBeLessThan(classifyIndex)
  })

  it('report is sent even when Phase 4 enrichment fails for all messages', async () => {
    // Phase 4: classifyEmail throws for every message
    vi.mocked(classifyEmail).mockRejectedValue(new Error('AI down'))

    // Mock: 2 unenriched messages
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  { id: 'msg-1', raw_text: 'Hello', cleaned_text: 'Hello', tag_primary: 'bulk_import' },
                  { id: 'msg-2', raw_text: 'World', cleaned_text: 'World', tag_primary: 'bulk_import' },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as never)

    const result = await runBulkIngestion('user-1', new Date('2024-01-01'))

    // Report was still sent
    expect(generateAndSendBackfillReport).toHaveBeenCalled()
    expect(result.report.sent).toBe(true)

    // Enrichment tracked failures
    expect(result.enrichment.enriched).toBe(0)
    expect(result.enrichment.enrichmentFailed).toBe(2)
  })

  it('enriches messages: classifyEmail + updateMessage + embedding', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'meeting_request',
      priority: 'high',
    })

    // Mock: 1 unenriched message
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ id: 'msg-1', raw_text: 'Meeting tomorrow?', cleaned_text: 'Meeting tomorrow?', tag_primary: 'bulk_import' }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as never)

    const result = await runBulkIngestion('user-1', new Date('2024-01-01'))

    expect(result.enrichment.enriched).toBe(1)
    expect(result.enrichment.enrichmentFailed).toBe(0)

    // classifyEmail called with body text
    expect(classifyEmail).toHaveBeenCalledWith('', 'Meeting tomorrow?', '')

    // updateMessage updates tags from classification
    expect(updateMessage).toHaveBeenCalledWith('msg-1', {
      tag_primary: 'meeting_request',
      tag_secondary: 'high',
    })

    // Embedding generated and saved
    expect(generateMessageEmbedding).toHaveBeenCalledWith('Meeting tomorrow?')
    expect(saveMessageEmbedding).toHaveBeenCalledWith('msg-1', expect.any(Array))
  })

  it('counts enriched message even when embedding fails', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'question',
      priority: 'medium',
    })
    vi.mocked(generateMessageEmbedding).mockRejectedValue(new Error('Embedding model down'))

    // Mock: 1 unenriched message
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ id: 'msg-1', raw_text: 'Question?', cleaned_text: 'Question?', tag_primary: 'bulk_import' }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as never)

    const result = await runBulkIngestion('user-1', new Date('2024-01-01'))

    // Classification succeeded — message counts as enriched
    expect(result.enrichment.enriched).toBe(1)
    expect(result.enrichment.enrichmentFailed).toBe(0)

    // updateMessage was still called
    expect(updateMessage).toHaveBeenCalledWith('msg-1', {
      tag_primary: 'question',
      tag_secondary: 'medium',
    })
  })

  it('streams Phase 4 progress via onProgress callback', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'update',
      priority: 'low',
    })

    // Mock: 1 unenriched message
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ id: 'msg-1', raw_text: 'Status update', cleaned_text: 'Status update', tag_primary: 'bulk_import' }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as never)

    const progressEvents: Record<string, unknown>[] = []
    await runBulkIngestion('user-1', new Date('2024-01-01'), undefined, 500, (p) => {
      progressEvents.push(p)
    })

    // Find Phase 4 progress events
    const phase4Events = progressEvents.filter(p => p.phase === 4)
    expect(phase4Events.length).toBeGreaterThanOrEqual(2) // loading + enriching/complete

    // Should have a 'complete' event
    const completeEvent = phase4Events.find(p => p.step === 'complete')
    expect(completeEvent).toBeDefined()
    expect(completeEvent?.enriched).toBe(1)
  })

  it('returns zero enrichment when no unenriched messages exist', async () => {
    // Default mock returns empty array — no unenriched messages
    const result = await runBulkIngestion('user-1', new Date('2024-01-01'))

    expect(result.enrichment.enriched).toBe(0)
    expect(result.enrichment.enrichmentFailed).toBe(0)

    // classifyEmail should NOT have been called (no messages to enrich)
    // Note: classifyEmail might be called by Phase 1 preFilter, but not by Phase 4
    // We verify by checking updateMessage was never called (Phase 4 is the only caller)
    expect(updateMessage).not.toHaveBeenCalled()
  })
})
