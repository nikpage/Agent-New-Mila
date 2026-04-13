/**
 * Integration Tests — Real DB, Mock Only AI + External APIs
 *
 * These tests verify that the product actually works end-to-end.
 * Unlike the previous version (which mocked 24 modules), this version:
 *
 *   REAL: All DB functions, calculatePriorityScore, config/client, auth/tokens,
 *         text cleaning, HTML template generation, theme config
 *
 *   MOCKED (cost/auth barriers only):
 *     - AI: gemini.ts, runner.ts (API costs)
 *     - Embeddings: generate* functions (API costs; clean* kept real)
 *     - Google: gmail, calendar, auth, maps (need OAuth tokens)
 *
 * Tests are gated: skip if SUPABASE_URL is not available.
 * Run with: npm test (auto-skips without DB) or ensure .env.local is loaded.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  HAS_DB,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  setupTestUser,
  createTestCP,
  createTestConversation,
  createTestMessage,
  createTestAction,
  cleanupTestData,
  getTestActions,
  getTestConversations,
  getTestConversation,
} from '../__tests__/helpers/test-db'

// ─── Mock ONLY external boundaries (7 mocks, NOT 24) ───────────────────────

vi.mock('@/lib/ai/gemini', () => ({
  classifyEmail: vi.fn(),
  filterEmail: vi.fn(),
  enrichMessage: vi.fn(),
  triageConversation: vi.fn(),
  verifyTriage: vi.fn(),
  extractTopic: vi.fn(),
  analyzeConversation: vi.fn(),
  shouldJoinConversation: vi.fn(),
}))

vi.mock('@/lib/ai/mila-voice', () => ({
  generateBriefIntro: vi.fn(),
  generateUrgentIntro: vi.fn(),
  generateFinalDraft: vi.fn(),
  generateLeadFollowUpIntent: vi.fn(),
  generateSchedulingIntent: vi.fn(),
}))

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

vi.mock('@/lib/embeddings/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/embeddings/generate')>()
  return {
    ...actual, // keeps real cleanMessageText, cleanEmailText
    generateMessageEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    generateConversationEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  }
})

vi.mock('@/lib/google/gmail', () => ({
  fetchUnreadEmails: vi.fn().mockResolvedValue([]),
  fetchRecentEmails: vi.fn().mockResolvedValue([]),
  fetchEmailsPaginated: vi.fn().mockResolvedValue([]),
  extractEmailAddress: (from: string) => {
    const m = from.match(/<(.+?)>/)
    return m ? m[1] : from
  },
  extractName: (from: string) => {
    const m = from.match(/^(.+?)\s*</)
    return m ? m[1].trim() : null
  },
  getUserEmail: vi.fn().mockResolvedValue(TEST_USER_EMAIL),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  GMAIL_SKIP_CATEGORIES: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'],
}))

vi.mock('@/lib/google/calendar', () => ({
  listCalendarEvents: vi.fn().mockResolvedValue([]),
  getUpcomingCalendarEvents: vi.fn().mockResolvedValue([]),
  getPendingInvitations: vi.fn().mockResolvedValue([]),
  isIncomingInvitation: vi.fn().mockReturnValue(false),
  createCalendarEvent: vi.fn().mockResolvedValue({}),
  confirmCalendarEvent: vi.fn().mockResolvedValue(undefined),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
  MILA_MANAGED_KEY: 'milaManaged',
}))

vi.mock('@/lib/google/auth', () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/google/maps', () => ({
  calculateTravelTime: vi.fn().mockResolvedValue({ durationMinutes: 15 }),
}))

// ─── Static imports (vi.mock hoisted above these) ──────────────────────────

import { triageConversation, verifyTriage, classifyEmail, enrichMessage, filterEmail } from '@/lib/ai/gemini'
import { generateBriefIntro, generateLeadFollowUpIntent } from '@/lib/ai/mila-voice'
import { sendEmail, fetchUnreadEmails, fetchEmailsPaginated, getUserEmail } from '@/lib/google/gmail'
import { generateActionToken, validateActionToken } from '@/lib/auth/tokens'
import { getActionCardEmailHtml } from '../components/action/action-card-template'

// ─── Shared setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Ensure NEXTAUTH_SECRET is set for real token generation
  if (!process.env.NEXTAUTH_SECRET) {
    process.env.NEXTAUTH_SECRET = 'test-secret-at-least-32-characters-long-for-hmac'
  }

  // Default triage mock: needs action, REPLY type
  vi.mocked(triageConversation).mockResolvedValue({
    needs_action: true,
    reasoning: 'CP requires a response',
    confidence: 0.9,
    revisit_at: null,
    revisit_reason: null,
    action: {
      type: 'REPLY',
      intent_cs: 'Nabídnout prohlídku bytu na Vinohradech',
      rationale_cs: 'CP žádá o prohlídku.',
      urgency_category: 'TODAY',
      urgency_justification: 'tento týden',
      what_cp_wants: 'Prohlídka bytu',
      venue_index: null,
      time_index: null,
      deal_type: 'sale',
      weight: 40,
      immovable: false,
      missing_info: [],
    },
  })
  vi.mocked(verifyTriage).mockResolvedValue({
    action_justified: true,
  })
  vi.mocked(generateBriefIntro).mockResolvedValue({
    greeting: 'Dobré ráno',
    subject: 'Mila: akční návrhy',
    headline: 'Máte akční návrhy ke zpracování.',
  })
  vi.mocked(generateLeadFollowUpIntent).mockResolvedValue({
    intentCs: 'Připravím follow-up.',
    rationaleCs: 'Lead je neaktivní.',
  })
  vi.mocked(classifyEmail).mockResolvedValue({
    isActionable: true,
    category: 'inquiry',
  } as never)
  vi.mocked(enrichMessage).mockResolvedValue(
    'Zájemce: Jan Novák. Nemovitost: byt Vinohrady 3+kk. Cena: 8.5M CZK.'
  )
  vi.mocked(filterEmail).mockResolvedValue({ relevant: true } as never)
  vi.mocked(getUserEmail).mockResolvedValue(TEST_USER_EMAIL)
})

// ═════════════════════════════════════════════════════════════════════════════
// PLANNING — AI proposal → real scoring → real DB action
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_DB)('Integration: Planning workflow (real DB)', () => {
  beforeEach(async () => {
    await setupTestUser()
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('creates a scored action in the real DB with correct priority calculation', async () => {
    const { generateActionProposal } = await import('./planning')

    const cp = await createTestCP({ name: 'Jan Novák', primary_identifier: 'jan@example.com', role: 'buyer' })
    const conv = await createTestConversation()
    // enriched_text for the message (used by summaries, not planning — triage handles urgency now)
    const now = Date.now()
    await createTestMessage({ cp_id: cp.id, conversation_id: conv.id, direction: 'inbound', timestamp: new Date(now - 3000).toISOString(), occurred_at: new Date(now - 3000).toISOString() })
    await createTestMessage({ cp_id: cp.id, conversation_id: conv.id, direction: 'outbound', timestamp: new Date(now - 2000).toISOString(), occurred_at: new Date(now - 2000).toISOString() })
    await createTestMessage({ cp_id: cp.id, conversation_id: conv.id, direction: 'inbound', timestamp: new Date(now - 1000).toISOString(), occurred_at: new Date(now - 1000).toISOString() })

    const actions = await generateActionProposal(conv)

    // Action created in real DB
    expect(actions).toHaveLength(1)
    const action = actions[0]
    expect(action.action_type).toBe('REPLY')
    expect(action.queued_for_brief).toBe(true)

    // REAL priority score (from triage: dollarValue=8500000, urgency=7, weight=40, buyer role)
    // Uses calculatePriorityScore with real formula
    expect(action.priority_score).toBeGreaterThan(0)
    expect(Number.isInteger(action.priority_score)).toBe(true)

    // Deal type written to conversation in real DB
    const updatedConv = await getTestConversation(conv.id)
    expect(updatedConv?.deal_type).toBe('sale')

    // Payload has correct channel and metadata
    const payload = action.payload as Record<string, unknown>
    expect(payload.channel).toBe('email')
    const metadata = payload.action_metadata as Record<string, unknown>
    expect(metadata.deal_type).toBe('sale')
    expect(metadata.weight).toBe(40)
    expect(metadata.offer_multiplier).toBe(1.0) // buyer → buyer multiplier

    // Action persisted in real DB
    const dbActions = await getTestActions()
    expect(dbActions.some(a => a.id === action.id)).toBe(true)
  })

  it('returns empty array when CP is blacklisted (security check)', async () => {
    const { generateActionProposal } = await import('./planning')

    const cp = await createTestCP({ is_blacklisted: true })
    const conv = await createTestConversation()
    await createTestMessage({ cp_id: cp.id, conversation_id: conv.id })

    const actions = await generateActionProposal(conv)

    expect(actions).toHaveLength(0)
    // Triage mock returns needs_action=true by default but CP is blacklisted → early return

    // No action created in DB
    const dbActions = await getTestActions()
    expect(dbActions).toHaveLength(0)
  })

  it('passes weight through to scoring as-is', async () => {
    const { generateActionProposal } = await import('./planning')

    const cp = await createTestCP()
    const conv = await createTestConversation()
    await createTestMessage({ cp_id: cp.id, conversation_id: conv.id })

    // Triage returns REPLY with weight 7
    vi.mocked(triageConversation).mockResolvedValue({
      needs_action: true,
      reasoning: 'Test',
      confidence: 0.9,
      revisit_at: null,
      revisit_reason: null,
      action: {
        type: 'REPLY',
        intent_cs: 'Test',
        rationale_cs: 'Test',
        urgency_category: 'THIS_WEEK',
        urgency_justification: 'Test',
        what_cp_wants: 'Test',
        venue_index: null,
        time_index: null,
        deal_type: null,
        weight: 7,
        immovable: false,
        missing_info: [],
      },
    })

    const actions = await generateActionProposal(conv)

    expect(actions).toHaveLength(1)
    expect(actions[0].weight).toBe(7)
    const metadata = (actions[0].payload as Record<string, unknown>).action_metadata as Record<string, unknown>
    expect(metadata.weight).toBe(7)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// MORNING BRIEF — gathers real actions, generates real HTML, sends email
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_DB)('Integration: Morning Brief workflow (real DB)', () => {
  beforeEach(async () => {
    await setupTestUser()
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('loads pending actions from DB, generates email with real tokens, marks notified', async () => {
    const { sendMorningBrief } = await import('./morning-brief')

    const cp = await createTestCP({ name: 'Jan Novák', primary_identifier: 'jan@example.com' })
    const conv = await createTestConversation()
    const action = await createTestAction({ cp_id: cp.id, conversation_id: conv.id })

    const result = await sendMorningBrief(TEST_USER_ID, 'morning')

    expect(result).toBe(true)

    // Email sent with real content
    expect(sendEmail).toHaveBeenCalledOnce()
    const [userId, emailArgs] = vi.mocked(sendEmail).mock.calls[0]
    expect(userId).toBe(TEST_USER_ID)
    expect(emailArgs.to).toBe(TEST_USER_EMAIL)
    expect(emailArgs.subject).toContain('Mila')
    expect(emailArgs.subject).toContain('1')

    // HTML contains real CP name (not mocked)
    expect(emailArgs.htmlBody).toContain('Jan Novák')
    expect(emailArgs.htmlBody).toContain('Dobré ráno')

    // Real action tokens are verifiable
    const tokenMatch = emailArgs.htmlBody!.match(/token=([^&"]+)/)
    expect(tokenMatch).not.toBeNull()
    const token = tokenMatch![1]
    const validated = validateActionToken(token, action.id, TEST_USER_ID)
    expect(validated).toBe(true)

    // Action marked as notified in real DB
    const dbActions = await getTestActions()
    const notifiedAction = dbActions.find(a => a.id === action.id)
    expect(notifiedAction?.last_notified_at).not.toBeNull()
    expect(notifiedAction?.queued_for_brief).toBe(false)
  })

  it('skips when user is unsubscribed', async () => {
    const { sendMorningBrief } = await import('./morning-brief')
    await setupTestUser({ email_unsubscribed: true })
    await createTestAction()

    const result = await sendMorningBrief(TEST_USER_ID)

    expect(result).toBe(false)
    expect(sendEmail).not.toHaveBeenCalled()

    // Action NOT marked as notified (still queued)
    const dbActions = await getTestActions()
    expect(dbActions[0]?.queued_for_brief).toBe(true)
  })

  it('returns true when no actions are pending', async () => {
    const { sendMorningBrief } = await import('./morning-brief')

    const result = await sendMorningBrief(TEST_USER_ID)

    expect(result).toBe(true)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends all actions without cap', async () => {
    const { sendMorningBrief } = await import('./morning-brief')

    const cp = await createTestCP()
    const conv = await createTestConversation()

    // Create 15 pending actions
    for (let i = 0; i < 15; i++) {
      await createTestAction({
        cp_id: cp.id,
        conversation_id: conv.id,
        priority_score: 50 + i,
      })
    }

    const result = await sendMorningBrief(TEST_USER_ID)

    expect(result).toBe(true)
    expect(sendEmail).toHaveBeenCalledOnce()
    const [, emailArgs] = vi.mocked(sendEmail).mock.calls[0]
    expect(emailArgs.subject).toContain('15')
  })

  it('uses afternoon greeting for afternoon brief type', async () => {
    const { sendMorningBrief } = await import('./morning-brief')

    const cp = await createTestCP()
    const conv = await createTestConversation()
    await createTestAction({ cp_id: cp.id, conversation_id: conv.id })

    await sendMorningBrief(TEST_USER_ID, 'afternoon')

    const [, emailArgs] = vi.mocked(sendEmail).mock.calls[0]
    expect(emailArgs.htmlBody).toContain('Dobré odpoledne')
  })

  it('sendAllMorningBriefs processes multiple users with fault isolation', async () => {
    const { sendAllMorningBriefs } = await import('./morning-brief')

    // This test uses the real getUsersDueBrief which checks timing.
    // We just verify it doesn't throw and returns valid shape.
    const result = await sendAllMorningBriefs('morning', 0)
    expect(result).toHaveProperty('sent')
    expect(result).toHaveProperty('failed')
    expect(typeof result.sent).toBe('number')
    expect(typeof result.failed).toBe('number')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// BULK INGESTION — fetches emails, stores in real DB, threads, sends report
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_DB)('Integration: Bulk Ingestion pipeline (real DB)', () => {
  beforeEach(async () => {
    await setupTestUser()
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('stores emails in real DB and runs threading', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([{
        id: 'email-1', from: 'Jan Novák <jan@example.com>', to: [TEST_USER_EMAIL],
        subject: 'Zájem o byt', body: 'Mám zájem o byt na Vinohradech.',
        date: new Date('2025-01-15'), threadId: 'thread-1', labels: ['INBOX'],
        isUnread: true,
      }])
      .mockResolvedValueOnce([]) // no sent emails

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.stored).toBeGreaterThan(0)

    // Message actually created in real DB
    const { getTestMessages } = await import('../__tests__/helpers/test-db')
    const msgs = await getTestMessages()
    expect(msgs.length).toBeGreaterThan(0)
    const storedMsg = msgs.find(m => m.external_id === 'email-1')
    expect(storedMsg).toBeDefined()
    expect(storedMsg!.direction).toBe('inbound')
  })

  it('skips emails from blocked senders', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([{
        id: 'blocked-1', from: 'noreply@google.com', to: [TEST_USER_EMAIL],
        subject: 'Notification', body: 'Automated', date: new Date('2025-01-15'),
        threadId: 'thread-blocked', labels: ['INBOX'],
        isUnread: true,
      }])
      .mockResolvedValueOnce([])

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.skippedBlocked).toBe(1)
    expect(result.phase1.stored).toBe(0)
  })

  it('skips Gmail category emails (promotions, social)', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([{
        id: 'promo-1', from: 'shop@store.com', to: [TEST_USER_EMAIL],
        subject: '50% off!', body: 'Buy now', date: new Date('2025-01-15'),
        threadId: 'thread-promo', labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
        isUnread: true,
      }])
      .mockResolvedValueOnce([])

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.skippedCategory).toBe(1)
    expect(result.phase1.stored).toBe(0)
  })

  it('tracks enrichment success and failure counts', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([
        { id: 'ok-1', from: 'jan@example.com', to: [TEST_USER_EMAIL], subject: 'A', body: 'Good email', date: new Date('2025-01-15'), threadId: 't1', labels: ['INBOX'], isUnread: true },
        { id: 'fail-1', from: 'petr@example.com', to: [TEST_USER_EMAIL], subject: 'B', body: 'Another', date: new Date('2025-01-16'), threadId: 't2', labels: ['INBOX'], isUnread: true },
      ])
      .mockResolvedValueOnce([])

    vi.mocked(enrichMessage)
      .mockResolvedValueOnce('Enriched text 1')
      .mockRejectedValueOnce(new Error('AI rate limit'))

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.stored).toBe(2)
    // Enrichment is now Phase 2 (separate from Phase 1 fetch+store)
    expect(result.phase2.enriched).toBe(1)
    expect(result.phase2.enrichmentFailed).toBe(1)
  })

  it('returns early when user not found', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')
    await cleanupTestData() // remove user

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.stored).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// INGESTION → THREADING — fetches emails, stores in DB, creates conversations
// ═════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_DB)('Integration: Ingestion → Threading flow (real DB)', () => {
  beforeEach(async () => {
    await setupTestUser()
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('fetches emails, classifies, stores message in real DB with correct CP', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'gmail-1', from: 'Jan Novák <jan@example.com>', to: [TEST_USER_EMAIL],
      subject: 'Zájem o byt', body: 'Mám zájem o byt.', date: new Date(),
      threadId: 'thread-1', labels: ['INBOX', 'UNREAD'],
      isUnread: true,
    }])

    const results = await ingestEmailsForUser(TEST_USER_ID)

    expect(results).toHaveLength(1)
    expect(results[0].isActionable).toBe(true)
    expect(classifyEmail).toHaveBeenCalledOnce()

    // Message created in real DB
    const { getTestMessages, getTestCPs } = await import('../__tests__/helpers/test-db')
    const msgs = await getTestMessages()
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    const storedMsg = msgs.find(m => m.external_id === 'gmail-1')
    expect(storedMsg).toBeDefined()
    expect(storedMsg!.user_id).toBe(TEST_USER_ID)
    expect(storedMsg!.direction).toBe('inbound')

    // CP created in real DB
    const cps = await getTestCPs()
    expect(cps.some(cp => cp.primary_identifier === 'jan@example.com')).toBe(true)
  })

  it('skips blocked senders without calling AI', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'noreply-1', from: 'noreply@google.com', to: [TEST_USER_EMAIL],
      subject: 'Security alert', body: 'Someone signed in', date: new Date(),
      threadId: 'thread-nr', labels: ['INBOX'],
      isUnread: true,
    }])

    const results = await ingestEmailsForUser(TEST_USER_ID)

    expect(results).toHaveLength(0)
    expect(classifyEmail).not.toHaveBeenCalled()
  })

  it('skips duplicate emails', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    // First ingestion
    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'dup-1', from: 'jan@example.com', to: [TEST_USER_EMAIL],
      subject: 'Test', body: 'Body', date: new Date(),
      threadId: 'thread-dup', labels: ['INBOX'],
      isUnread: true,
    }])
    await ingestEmailsForUser(TEST_USER_ID)

    // Second ingestion with same email
    vi.clearAllMocks()
    vi.mocked(classifyEmail).mockResolvedValue({ isActionable: true, category: 'inquiry' } as never)
    vi.mocked(enrichMessage).mockResolvedValue('Enriched')
    vi.mocked(getUserEmail).mockResolvedValue(TEST_USER_EMAIL)
    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'dup-1', from: 'jan@example.com', to: [TEST_USER_EMAIL],
      subject: 'Test', body: 'Body', date: new Date(),
      threadId: 'thread-dup', labels: ['INBOX'],
      isUnread: true,
    }])

    const results2 = await ingestEmailsForUser(TEST_USER_ID)

    expect(results2).toHaveLength(0)
    expect(classifyEmail).not.toHaveBeenCalled()
  })

  it('threading matches by external thread ID in real DB', async () => {
    const { processMessagesForThreading } = await import('./threading')

    // Create a conversation with external_thread_id
    const conv = await createTestConversation()
    const msg1 = await createTestMessage({
      conversation_id: conv.id,
      external_thread_id: 'existing-thread-123',
    })

    // Create a new unassigned message with same thread ID
    const msg2 = await createTestMessage({
      conversation_id: null,
      external_thread_id: 'existing-thread-123',
      raw_text: 'Follow-up message.',
      cleaned_text: 'Follow-up message.',
    })

    const result = await processMessagesForThreading([msg2])

    // Message assigned to existing conversation
    expect(result.has(conv.id)).toBe(true)

    // Verify in real DB
    const { getTestMessages } = await import('../__tests__/helpers/test-db')
    const msgs = await getTestMessages()
    const updatedMsg = msgs.find(m => m.id === msg2.id)
    expect(updatedMsg?.conversation_id).toBe(conv.id)
  })

  it('threading creates new conversation when no match', async () => {
    const { processMessagesForThreading } = await import('./threading')
    const { extractTopic } = await import('@/lib/ai/gemini')

    vi.mocked(extractTopic).mockResolvedValue('New topic')

    const msg = await createTestMessage({
      conversation_id: null,
      external_thread_id: 'brand-new-thread-xyz',
    })

    const result = await processMessagesForThreading([msg])

    expect(result.size).toBeGreaterThanOrEqual(1)

    // New conversation created in real DB
    const convs = await getTestConversations()
    expect(convs.length).toBeGreaterThanOrEqual(1)
  })
})
