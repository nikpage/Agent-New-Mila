/**
 * Bulk Ingestion Tests — Phase 4 Enrichment (real DB)
 *
 * Tests that Phase 4 enrichment correctly classifies, updates, and embeds
 * messages that were stored during Phase 1 without enrichment.
 *
 * REAL: All DB operations, message updates, phase ordering
 * MOCKED: AI (classify, enrich), embeddings (generate), Google APIs, backfill report
 *
 * Gated: skips when SUPABASE_URL is not available.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  HAS_DB,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  setupTestUser,
  createTestMessage,
  cleanupTestData,
  getTestMessages,
} from '../__tests__/helpers/test-db'

// Track call order to verify phase sequencing
const callOrder: string[] = []

// ─── Mock ONLY external boundaries ─────────────────────────────────────────

vi.mock('@/lib/ai/gemini', () => ({
  preFilterEmail: vi.fn().mockResolvedValue({ relevant: true }),
  classifyEmail: vi.fn().mockResolvedValue({
    isActionable: true,
    category: 'question',
    priority: 'medium',
  }),
  enrichMessage: vi.fn().mockResolvedValue('Enriched: key facts extracted'),
}))

vi.mock('@/lib/ai/runner', () => ({
  probeAIAvailability: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/embeddings/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/embeddings/generate')>()
  return {
    ...actual,
    generateMessageEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    generateConversationEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  }
})

vi.mock('@/lib/google/gmail', () => ({
  fetchEmailsPaginated: vi.fn().mockResolvedValue([]),
  extractEmailAddress: (s: string) => { const m = s.match(/<(.+?)>/); return m ? m[1] : s },
  extractName: () => null,
  getUserEmail: vi.fn().mockResolvedValue(TEST_USER_EMAIL),
  GMAIL_SKIP_CATEGORIES: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'],
}))

vi.mock('@/lib/google/auth', () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}))

vi.mock('./backfill-report', () => ({
  generateAndSendBackfillReport: vi.fn().mockImplementation(async () => {
    callOrder.push('phase3_report')
    return { sent: true }
  }),
}))

// ─── Static imports ─────────────────────────────────────────────────────────

import { runBulkIngestion } from './bulk-ingestion'
import { classifyEmail, enrichMessage } from '@/lib/ai/gemini'
import { generateMessageEmbedding } from '@/lib/embeddings/generate'
import { generateAndSendBackfillReport } from './backfill-report'
import { fetchEmailsPaginated } from '@/lib/google/gmail'

// ─── Shared setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
})

// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_DB)('Bulk Ingestion — Phase 4 enrichment (real DB)', () => {
  beforeEach(async () => {
    await setupTestUser()
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('Phase 3 report is sent before Phase 4 enrichment starts', async () => {
    // Track when Phase 4 classify happens
    vi.mocked(classifyEmail).mockImplementation(async () => {
      callOrder.push('phase4_classify')
      return { isActionable: true, category: 'question', priority: 'medium' }
    })

    // Pre-create an unenriched message (simulates Phase 1 output)
    await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: null, // not yet enriched
    })

    await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    const reportIndex = callOrder.indexOf('phase3_report')
    const classifyIndex = callOrder.indexOf('phase4_classify')
    expect(reportIndex).toBeGreaterThanOrEqual(0)
    expect(classifyIndex).toBeGreaterThanOrEqual(0)
    expect(reportIndex).toBeLessThan(classifyIndex)
  })

  it('report is sent even when Phase 4 enrichment fails for all messages', async () => {
    vi.mocked(classifyEmail).mockRejectedValue(new Error('AI down'))

    await createTestMessage({ tag_primary: 'bulk_import', enriched_text: null })
    await createTestMessage({ tag_primary: 'bulk_import', enriched_text: null, raw_text: 'Another msg', cleaned_text: 'Another msg' })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(generateAndSendBackfillReport).toHaveBeenCalled()
    expect(result.report.sent).toBe(true)
    expect(result.enrichment.enriched).toBe(0)
    expect(result.enrichment.enrichmentFailed).toBe(2)
  })

  it('enriches messages: classifyEmail + updateMessage + embedding in real DB', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'meeting_request',
      priority: 'high',
    })
    vi.mocked(enrichMessage).mockResolvedValue('Enriched: meeting request details')

    const msg = await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: null,
      raw_text: 'Meeting tomorrow?',
      cleaned_text: 'Meeting tomorrow?',
    })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(result.enrichment.enriched).toBe(1)
    expect(result.enrichment.enrichmentFailed).toBe(0)

    // Verify message updated in real DB
    const msgs = await getTestMessages()
    const updated = msgs.find(m => m.id === msg.id)
    expect(updated?.tag_primary).toBe('meeting_request')
    expect(updated?.tag_secondary).toBe('high')
    expect(updated?.enriched_text).toBe('Enriched: meeting request details')
  })

  it('counts enriched message even when embedding fails', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'question',
      priority: 'medium',
    })
    vi.mocked(generateMessageEmbedding).mockRejectedValue(new Error('Embedding model down'))

    await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: null,
    })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(result.enrichment.enriched).toBe(1)
    expect(result.enrichment.enrichmentFailed).toBe(0)
  })

  it('streams Phase 4 progress via onProgress callback', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'update',
      priority: 'low',
    })

    await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: null,
    })

    const progressEvents: Record<string, unknown>[] = []
    await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'), undefined, 500, (p) => {
      progressEvents.push(p)
    })

    const phase4Events = progressEvents.filter(p => p.phase === 4)
    expect(phase4Events.length).toBeGreaterThanOrEqual(2)

    const completeEvent = phase4Events.find(p => p.step === 'complete')
    expect(completeEvent).toBeDefined()
    expect(completeEvent?.enriched).toBe(1)
  })

  it('returns zero enrichment when no unenriched messages exist', async () => {
    // All messages already have enriched_text (default from createTestMessage)
    await createTestMessage({ tag_primary: 'inquiry' })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(result.enrichment.enriched).toBe(0)
    expect(result.enrichment.enrichmentFailed).toBe(0)
  })
})
