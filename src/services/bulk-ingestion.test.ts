/**
 * Bulk Ingestion Tests — 5-phase pipeline (real DB)
 *
 * Tests that the 5-phase bulk ingestion correctly processes emails:
 *   Phase 1: Fetch & store (filter only)
 *   Phase 2: Enrich + embed
 *   Phase 3: Thread
 *   Phase 4: Classify (replaces bulk_import tag)
 *   Phase 5: Report
 *
 * REAL: All DB operations, message updates, phase ordering
 * MOCKED: AI (filter, classify, enrich), embeddings (generate), Google APIs, backfill report
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
  filterEmail: vi.fn().mockResolvedValue({ relevant: true }),
  classifyEmail: vi.fn().mockResolvedValue({
    isActionable: true,
    category: 'question',
    priority: 'medium',
  }),
  enrichMessage: vi.fn().mockResolvedValue('Enriched: key facts extracted'),
  extractTopic: vi.fn().mockResolvedValue('Test topic'),
  analyzeConversation: vi.fn().mockResolvedValue({
    currentState: 'Active', nextSteps: ['Reply'], keyPoints: ['Key'],
    risks: [], confidence: 0.8, confidenceReason: 'Test', dealType: null,
  }),
  shouldJoinConversation: vi.fn().mockResolvedValue(false),
  proposeAction: vi.fn().mockResolvedValue({
    actionType: 'WAIT', rationale_cs: 'Test', intent_cs: null,
    missingInfo: [], dollarValue: 0, urgency: 1,
    weight: 1, dealType: null,
  }),
  generateFinalDraft: vi.fn().mockResolvedValue({ subject: 'Test', body: 'Test' }),
  generateBriefHeadline: vi.fn().mockResolvedValue('Test headline'),
}))

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
  getLastAICallInfo: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/ai/providers/gemini', () => ({
  getLastKeyLabel: vi.fn().mockReturnValue(null),
  getKeyUsageSummary: vi.fn().mockReturnValue('no Gemini calls'),
  geminiProvider: {},
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
    callOrder.push('phase5_report')
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

describe.skipIf(!HAS_DB)('Bulk Ingestion — 5-phase pipeline (real DB)', () => {
  beforeEach(async () => {
    await setupTestUser()
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('Phase 4 classify runs before Phase 5 report', async () => {
    // Track when Phase 4 classify happens
    vi.mocked(classifyEmail).mockImplementation(async () => {
      callOrder.push('phase4_classify')
      return { isActionable: true, category: 'question', priority: 'medium' }
    })

    // Pre-create a bulk_import message with enriched_text set
    // (simulates Phase 1 store + Phase 2 enrich already done)
    await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: 'Already enriched',
    })

    await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    const reportIndex = callOrder.indexOf('phase5_report')
    const classifyIndex = callOrder.indexOf('phase4_classify')
    expect(classifyIndex).toBeGreaterThanOrEqual(0)
    expect(reportIndex).toBeGreaterThanOrEqual(0)
    expect(classifyIndex).toBeLessThan(reportIndex)
  })

  it('report is sent even when Phase 4 classify fails for all messages', async () => {
    vi.mocked(classifyEmail).mockRejectedValue(new Error('AI down'))

    await createTestMessage({ tag_primary: 'bulk_import', enriched_text: 'Enriched' })
    await createTestMessage({ tag_primary: 'bulk_import', enriched_text: 'Enriched', raw_text: 'Another msg', cleaned_text: 'Another msg' })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(generateAndSendBackfillReport).toHaveBeenCalled()
    expect(result.report.sent).toBe(true)
    expect(result.phase4.classified).toBe(0)
    expect(result.phase4.classifyFailed).toBe(2)
  })

  it('classifies messages: classifyEmail → update tag in real DB', async () => {
    vi.mocked(classifyEmail).mockResolvedValue({
      isActionable: true,
      category: 'meeting_request',
      priority: 'high',
    })

    const msg = await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: 'Enriched: meeting request details',
    })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(result.phase4.classified).toBe(1)
    expect(result.phase4.classifyFailed).toBe(0)

    // Verify message updated in real DB
    const msgs = await getTestMessages()
    const updated = msgs.find(m => m.id === msg.id)
    expect(updated?.tag_primary).toBe('meeting_request')
    expect(updated?.tag_secondary).toBe('high')
  })

  it('enriches messages in Phase 2 and embeds them', async () => {
    vi.mocked(enrichMessage).mockResolvedValue('Enriched: key info')

    const msg = await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: null, // not yet enriched
    })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(result.phase2.enriched).toBe(1)
    expect(result.phase2.enrichmentFailed).toBe(0)
    expect(result.phase2.embedded).toBe(1)

    // Verify enriched text saved in real DB
    const msgs = await getTestMessages()
    const updated = msgs.find(m => m.id === msg.id)
    expect(updated?.enriched_text).toBe('Enriched: key info')
  })

  it('counts enrichment failure when embedding fails', async () => {
    vi.mocked(enrichMessage).mockResolvedValue('Enriched text')
    vi.mocked(generateMessageEmbedding).mockRejectedValue(new Error('Embedding model down'))

    await createTestMessage({
      tag_primary: 'bulk_import',
      enriched_text: null,
    })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    // Enrichment succeeds, embedding fails
    expect(result.phase2.enriched).toBe(1)
    expect(result.phase2.embeddingFailed).toBe(1)
  })

  it('streams progress for Phase 2 and Phase 4', async () => {
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

    // Phase 2 (enrich) events
    const phase2Events = progressEvents.filter(p => p.phase === 2)
    expect(phase2Events.length).toBeGreaterThanOrEqual(2)
    const phase2Complete = phase2Events.find(p => p.step === 'complete')
    expect(phase2Complete).toBeDefined()

    // Phase 4 (classify) events
    const phase4Events = progressEvents.filter(p => p.phase === 4)
    expect(phase4Events.length).toBeGreaterThanOrEqual(2)
    const phase4Complete = phase4Events.find(p => p.step === 'complete')
    expect(phase4Complete).toBeDefined()
  })

  it('returns zero counts when no bulk_import messages exist', async () => {
    // All messages already have real tags (not bulk_import)
    await createTestMessage({ tag_primary: 'inquiry' })

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2024-01-01'))

    expect(result.phase2.enriched).toBe(0)
    expect(result.phase4.classified).toBe(0)
  })
})
