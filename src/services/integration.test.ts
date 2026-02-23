/**
 * Integration Tests — Real Workflow Coverage
 *
 * These tests verify that the product actually works end-to-end:
 * - Agent pipeline runs steps 1-6 and data flows between them
 * - Bulk ingestion fetches, stores, threads, and sends a report
 * - Planning takes a conversation and produces a scored action in the DB
 * - Morning brief gathers actions and sends an email
 * - Ingestion fetches emails, classifies, stores, and threads them
 *
 * Strategy: mock at the boundary (DB, AI, Google APIs) but let service
 * code wire together for real. Verify data flows between steps.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, ConversationThread, ActionProposal } from '@/lib/supabase/types'

// ─── Shared test data (defined before vi.mock so factories can reference them)

const TEST_USER_ID = 'user-integration-1'
const TEST_CP_ID = 'cp-integration-1'
const TEST_CONV_ID = 'conv-integration-1'
const TEST_ACTION_ID = 'action-integration-1'

const testUser = {
  id: TEST_USER_ID,
  email: 'testuser@gmail.com',
  mila_name: 'Test User',
  public_name: 'Test User',
  email_timezone: 'Europe/Prague',
  email_enabled: true,
  email_unsubscribed: false,
  google_oauth_tokens: { access_token: 'valid-token', refresh_token: 'valid-refresh' },
  settings: null,
  created_at: new Date().toISOString(),
}

const testCP = {
  id: TEST_CP_ID,
  user_id: TEST_USER_ID,
  name: 'Jan Novák',
  primary_identifier: 'jan@example.com',
  other_identifiers: null,
  role: 'buyer' as const,
  locations: null,
  is_blacklisted: false,
  created_at: new Date().toISOString(),
}

const defaultSettings = {
  working_hours_start: '09:00', working_hours_end: '17:00', working_days: [1, 2, 3, 4, 5],
  timezone: 'Europe/Prague', default_meeting_duration: 30, default_meeting_type: 'online',
  meeting_buffer_minutes: 15, travel_mode: 'driving', home_location: null, office_location: null,
  offer_multiplier_seller: 1.5, offer_multiplier_buyer: 1.0, priority_multiplier_vip: 2.0,
  kc_factor: 13, ai_tone_user: 'Professional', ai_tone_cp: 'Polite', user_alias: 'Test User',
  morning_brief_time: '08:00', afternoon_brief_time: '13:00',
  default_delegate_email: null, todo_auto_due_days: 1,
  high_value_signals: ['milion', 'nabídka', 'exkluziv'],
  calendar: { personalEventKeywords: ['dentist', 'doctor', 'gym'] },
  typical_deal_size_currency: 'CZK',
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1', user_id: TEST_USER_ID, cp_id: TEST_CP_ID, channel_id: 'email',
    thread_id: null, conversation_id: null, external_thread_id: 'gmail-thread-1',
    universal_message_id: 'gmail-msg-1', external_id: 'gmail-msg-1', direction: 'inbound',
    raw_text: 'Dobrý den, mám zájem o byt na Vinohradech za 8.5M CZK.',
    cleaned_text: 'Dobrý den, mám zájem o byt na Vinohradech za 8.5M CZK.',
    enriched_text: 'Zájemce: Jan Novák. Nemovitost: byt Vinohrady. Cena: 8.5M CZK.',
    message_type: null, tag_primary: 'inquiry', tag_secondary: 'high',
    timestamp: new Date().toISOString(), occurred_at: new Date().toISOString(),
    ...overrides,
  } as Message
}

function makeConversation(overrides: Partial<ConversationThread> = {}): ConversationThread {
  return {
    id: TEST_CONV_ID, user_id: TEST_USER_ID, topic: 'Byt Vinohrady 3+kk',
    summary_text: 'Jan Novák má zájem o koupi bytu.',
    summary_json: { currentState: 'Zájem projevil', nextSteps: ['Prohlídka'], keyPoints: ['8.5M CZK'], risks: [], confidence: 0.85, confidenceReason: 'Clear deal progression', dealType: 'sale' },
    summary_confidence: 0.85, summary_confidence_reason: 'Clear deal progression', messages_since_rebuild: 0,
    message_count: 3, state: 'active', deal_type: 'sale', priority_score: 50,
    embedding: null, last_updated: new Date().toISOString(), created_at: new Date().toISOString(),
    ...overrides,
  } as ConversationThread
}

// ─── ALL vi.mock() calls at FILE scope ─────────────────────────────────────
// vi.mock is hoisted above imports, so these run first.

vi.mock('@/lib/ai/runner', () => ({
  probeAIAvailability: vi.fn(),
  runAITask: vi.fn(),
  isGeminiDisabled: vi.fn(),
}))

vi.mock('@/lib/db/locks', () => ({
  tryAcquireUserLock: vi.fn(),
  releaseUserLock: vi.fn(),
}))

vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn(),
  getUserSettings: vi.fn(),
  upsertUser: vi.fn(),
  getUsersDueBrief: vi.fn(),
  getUsersWithEmailEnabled: vi.fn(),
}))

vi.mock('@/lib/db/counterparties', () => ({
  purgeUserAsCp: vi.fn(),
  findOrCreateCP: vi.fn(),
  getCPById: vi.fn(),
  isSameGmailAddress: vi.fn(),
  normalizeGmailAddress: vi.fn(),
  getCPsForUser: vi.fn(),
}))

vi.mock('@/lib/db/messages', () => ({
  getUnprocessedMessages: vi.fn(),
  createMessage: vi.fn(),
  messageExists: vi.fn(),
  updateMessage: vi.fn(),
  getMessageById: vi.fn(),
  getLatestMessageFromCP: vi.fn(),
}))

vi.mock('@/lib/db/conversations', () => ({
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  updateConversationSummary: vi.fn(),
  incrementMessageCount: vi.fn(),
  addParticipant: vi.fn(),
  findConversationByExternalThread: vi.fn(),
  getRecentMessages: vi.fn(),
  getConversationsForUser: vi.fn(),
}))

vi.mock('@/lib/db/actions', () => ({
  createAction: vi.fn(),
  getActionById: vi.fn(),
  calculatePriorityScore: vi.fn(),
  hasPendingAction: vi.fn(),
  getPendingActionsForBrief: vi.fn(),
  markActionsNotified: vi.fn(),
  getActionsForUser: vi.fn(),
}))

vi.mock('@/lib/db/todos', () => ({
  createTodo: vi.fn(),
  getTodoById: vi.fn(),
  updateTodo: vi.fn(),
  getTodosForUser: vi.fn(),
}))

vi.mock('@/lib/db/events', () => ({
  getEventsForToday: vi.fn(),
  getEventsInRange: vi.fn(),
  getUpcomingEvents: vi.fn(),
  createEvent: vi.fn(),
  calculateEventScore: vi.fn(),
}))

vi.mock('@/lib/db/embeddings', () => ({
  saveMessageEmbedding: vi.fn(),
  saveConversationEmbedding: vi.fn(),
  searchSimilarMessages: vi.fn(),
  getConversationsWithEmbeddingsByCP: vi.fn(),
}))

vi.mock('@/lib/db/gdpr', () => ({
  writeAuditLog: vi.fn(),
}))

vi.mock('@/lib/google/gmail', () => ({
  fetchUnreadEmails: vi.fn(),
  fetchRecentEmails: vi.fn(),
  fetchEmailsPaginated: vi.fn(),
  extractEmailAddress: vi.fn(),
  extractName: vi.fn(),
  getUserEmail: vi.fn(),
  sendEmail: vi.fn(),
  GMAIL_SKIP_CATEGORIES: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'],
}))

vi.mock('@/lib/google/calendar', () => ({
  listCalendarEvents: vi.fn(),
  createCalendarEvent: vi.fn(),
}))

vi.mock('@/lib/google/auth', () => ({
  getAuthenticatedClient: vi.fn(),
}))

vi.mock('@/lib/ai/gemini', () => ({
  classifyEmail: vi.fn(),
  preFilterEmail: vi.fn(),
  enrichMessage: vi.fn(),
  proposeAction: vi.fn(),
  extractTopic: vi.fn(),
  analyzeConversation: vi.fn(),
  shouldJoinConversation: vi.fn(),
  generateBriefHeadline: vi.fn(),
  generateFinalDraft: vi.fn(),
}))

vi.mock('@/lib/embeddings/generate', () => ({
  generateMessageEmbedding: vi.fn(),
  generateConversationEmbedding: vi.fn(),
  cleanMessageText: vi.fn(),
  cleanEmailText: vi.fn(),
}))

vi.mock('@/lib/auth/tokens', () => ({
  generateActionToken: vi.fn(),
  generateTriggerToken: vi.fn(),
  generateBackfillToken: vi.fn(),
  validateActionToken: vi.fn(),
  validateCronToken: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => {
  const chainable: Record<string, unknown> = { data: [], error: null }
  chainable.eq = vi.fn().mockReturnValue(chainable)
  chainable.not = vi.fn().mockReturnValue(chainable)
  chainable.order = vi.fn().mockReturnValue(chainable)
  return {
    getSupabaseAdmin: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(chainable),
      }),
    }),
  }
})

vi.mock('./scheduling', () => ({
  proposeMeeting: vi.fn(),
  findFreeSlots: vi.fn(),
}))

vi.mock('./calendar-ingestion', () => ({
  ingestCalendarEvents: vi.fn(),
}))

vi.mock('./lead-tracking', () => ({
  trackLeadsForUser: vi.fn(),
  getLeadStatus: vi.fn(),
}))

vi.mock('./backfill-report', () => ({
  generateAndSendBackfillReport: vi.fn().mockResolvedValue({ sent: true }),
}))

vi.mock('../components/action/action-card-template', () => ({
  getActionCardEmailHtml: vi.fn().mockReturnValue('<div>Action Card</div>'),
}))

vi.mock('@/config/theme', () => ({
  theme: {
    colors: {
      background: '#fff', text: '#000', textMuted: '#666', primary: '#0066cc',
      primaryLight: '#3399ff', secondary: '#f5f5f5', accent: '#ff6600',
      surface: '#fafafa', border: '#eee', success: '#00cc66',
      warning: '#ffcc00', error: '#cc0000',
    },
  },
}))

// ─── Static imports (vi.mock hoisted above these) ──────────────────────────

import { probeAIAvailability } from '@/lib/ai/runner'
import { tryAcquireUserLock, releaseUserLock } from '@/lib/db/locks'
import { getUserById, getUserSettings, getUsersDueBrief } from '@/lib/db/users'
import { purgeUserAsCp, findOrCreateCP, getCPById, isSameGmailAddress, normalizeGmailAddress } from '@/lib/db/counterparties'
import { getUnprocessedMessages, createMessage, messageExists, updateMessage, getLatestMessageFromCP } from '@/lib/db/messages'
import { getConversationById, createConversation, updateConversation, updateConversationSummary, incrementMessageCount, addParticipant, findConversationByExternalThread, getRecentMessages } from '@/lib/db/conversations'
import { createAction, calculatePriorityScore, getPendingActionsForBrief, markActionsNotified, hasPendingAction } from '@/lib/db/actions'
import { createTodo } from '@/lib/db/todos'
import { getEventsForToday, getUpcomingEvents } from '@/lib/db/events'
import { saveMessageEmbedding, saveConversationEmbedding, getConversationsWithEmbeddingsByCP } from '@/lib/db/embeddings'
import { fetchUnreadEmails, fetchRecentEmails, fetchEmailsPaginated, extractEmailAddress, extractName, getUserEmail, sendEmail } from '@/lib/google/gmail'
import { classifyEmail, preFilterEmail, enrichMessage, proposeAction, extractTopic, analyzeConversation, shouldJoinConversation, generateBriefHeadline } from '@/lib/ai/gemini'
import { generateMessageEmbedding, generateConversationEmbedding, cleanMessageText } from '@/lib/embeddings/generate'
import { generateActionToken, generateTriggerToken, generateBackfillToken } from '@/lib/auth/tokens'
import { ingestCalendarEvents } from './calendar-ingestion'
import { trackLeadsForUser } from './lead-tracking'
import { generateAndSendBackfillReport } from './backfill-report'

// ─── Shared mock reset ─────────────────────────────────────────────────────

function resetMocks() {
  // DB: users
  vi.mocked(getUserById).mockResolvedValue(testUser as never)
  vi.mocked(getUserSettings).mockResolvedValue(defaultSettings as never)
  vi.mocked(getUsersDueBrief).mockResolvedValue([])

  // DB: counterparties
  vi.mocked(getCPById).mockResolvedValue(testCP as never)
  vi.mocked(findOrCreateCP).mockResolvedValue(testCP as never)
  vi.mocked(purgeUserAsCp).mockResolvedValue(0 as never)
  vi.mocked(isSameGmailAddress).mockImplementation((a: string, b: string) =>
    a.toLowerCase().replace(/\./g, '') === b.toLowerCase().replace(/\./g, '')
  )
  vi.mocked(normalizeGmailAddress).mockImplementation((e: string) => e.toLowerCase())

  // DB: conversations
  vi.mocked(getConversationById).mockResolvedValue(makeConversation())
  vi.mocked(createConversation).mockImplementation((c) => Promise.resolve({ ...makeConversation(), ...c } as never))
  vi.mocked(findConversationByExternalThread).mockResolvedValue(null)
  vi.mocked(getRecentMessages).mockResolvedValue([makeMessage()])
  vi.mocked(updateConversation).mockResolvedValue(undefined as never)
  vi.mocked(updateConversationSummary).mockResolvedValue(undefined as never)
  vi.mocked(incrementMessageCount).mockResolvedValue(undefined as never)
  vi.mocked(addParticipant).mockResolvedValue(undefined as never)

  // DB: messages
  vi.mocked(messageExists).mockResolvedValue(false)
  vi.mocked(createMessage).mockImplementation((m) => Promise.resolve(m as never))
  vi.mocked(getUnprocessedMessages).mockResolvedValue([])
  vi.mocked(updateMessage).mockResolvedValue(undefined as never)
  vi.mocked(getLatestMessageFromCP).mockResolvedValue(
    makeMessage({ timestamp: new Date(Date.now() - 2 * 86400000).toISOString() })
  )

  // DB: actions
  vi.mocked(createAction).mockImplementation((a) => Promise.resolve({ ...a, status: 'pending', created_at: new Date().toISOString() } as never))
  vi.mocked(calculatePriorityScore).mockReturnValue(42)
  vi.mocked(getPendingActionsForBrief).mockResolvedValue([])
  vi.mocked(markActionsNotified).mockResolvedValue(undefined as never)
  vi.mocked(hasPendingAction).mockResolvedValue(false)

  // DB: events, embeddings, todos, locks
  vi.mocked(getEventsForToday).mockResolvedValue([])
  vi.mocked(getUpcomingEvents).mockResolvedValue([])
  vi.mocked(saveMessageEmbedding).mockResolvedValue(undefined as never)
  vi.mocked(saveConversationEmbedding).mockResolvedValue(undefined as never)
  vi.mocked(getConversationsWithEmbeddingsByCP).mockResolvedValue([])
  vi.mocked(createTodo).mockResolvedValue({ id: 'todo-1' } as never)
  vi.mocked(tryAcquireUserLock).mockResolvedValue(true)
  vi.mocked(releaseUserLock).mockResolvedValue(undefined as never)

  // Google APIs
  vi.mocked(fetchUnreadEmails).mockResolvedValue([])
  vi.mocked(fetchRecentEmails).mockResolvedValue([])
  vi.mocked(fetchEmailsPaginated).mockResolvedValue([])
  vi.mocked(extractEmailAddress).mockImplementation((from: string) => {
    const match = from.match(/<(.+?)>/)
    return match ? match[1] : from
  })
  vi.mocked(extractName).mockImplementation((from: string) => {
    const match = from.match(/^(.+?)\s*</)
    return match ? match[1].trim() : null
  })
  vi.mocked(getUserEmail).mockResolvedValue('testuser@gmail.com')
  vi.mocked(sendEmail).mockResolvedValue(undefined as never)

  // AI
  vi.mocked(classifyEmail).mockResolvedValue({ isActionable: true, category: 'inquiry', priority: 'high' } as never)
  vi.mocked(preFilterEmail).mockResolvedValue({ relevant: true } as never)
  vi.mocked(enrichMessage).mockResolvedValue('Enriched: Jan Novák, byt Vinohrady, 8.5M CZK.')
  vi.mocked(proposeAction).mockResolvedValue({
    actionType: 'REPLY', rationale_cs: 'Odpovědět', intent_cs: 'Test intent',
    missingInfo: [], dollarValue: 8500000, urgency: 7, painFactor: 3, weight: 40, dealType: 'sale',
  } as never)
  vi.mocked(extractTopic).mockResolvedValue('Byt Vinohrady 3+kk')
  vi.mocked(analyzeConversation).mockResolvedValue({
    currentState: 'Zájem projevil', nextSteps: ['Prohlídka'], keyPoints: ['8.5M CZK'],
    risks: [], confidence: 0.85, confidenceReason: 'Clear deal progression with concrete price', dealType: 'sale',
  } as never)
  vi.mocked(shouldJoinConversation).mockResolvedValue(false)
  vi.mocked(generateBriefHeadline).mockResolvedValue('Máte akční návrhy.')
  vi.mocked(probeAIAvailability).mockResolvedValue(undefined)

  // Embeddings
  vi.mocked(generateMessageEmbedding).mockResolvedValue(new Array(768).fill(0.1))
  vi.mocked(generateConversationEmbedding).mockResolvedValue(new Array(768).fill(0.1))
  vi.mocked(cleanMessageText).mockImplementation((text: string) => text)

  // Auth tokens
  vi.mocked(generateActionToken).mockReturnValue('mock-action-token')
  vi.mocked(generateTriggerToken).mockReturnValue('mock-trigger-token')
  vi.mocked(generateBackfillToken).mockReturnValue('mock-backfill-token')

  // Services (mocked as boundaries for agent pipeline)
  vi.mocked(ingestCalendarEvents).mockResolvedValue({
    eventsSynced: 3, invitationsDetected: 1, actionsCreated: 0, errors: [],
  } as never)
  vi.mocked(trackLeadsForUser).mockResolvedValue({
    conversationsScanned: 5, coolingLeads: 1, coldLeads: 0, deadLeads: 0,
    followUpsCreated: 1, errors: [],
  } as never)
  vi.mocked(generateAndSendBackfillReport).mockResolvedValue({ sent: true })
}

// ═════════════════════════════════════════════════════════════════════════════
// GLOBAL beforeEach — reset all mocks to sane defaults
// ═════════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.clearAllMocks()
  resetMocks()
})

// Agent pipeline tests are in agent-pipeline.test.ts (separate mock scope)

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE 1: Planning — AI → DB flow
// ═════════════════════════════════════════════════════════════════════════════

describe('Integration: Planning workflow', () => {
  it('takes a conversation, calls AI, creates a scored action in the DB', async () => {
    const { generateActionProposal } = await import('./planning')

    vi.mocked(getRecentMessages).mockResolvedValue([
      makeMessage({ id: 'msg-1', direction: 'inbound', cp_id: TEST_CP_ID }),
      makeMessage({ id: 'msg-2', direction: 'outbound', cp_id: TEST_CP_ID }),
      makeMessage({ id: 'msg-3', direction: 'inbound', cp_id: TEST_CP_ID }),
    ])
    vi.mocked(calculatePriorityScore).mockReturnValue(75)
    vi.mocked(createAction).mockImplementation((a) =>
      Promise.resolve({ ...a, status: 'pending', created_at: new Date().toISOString() } as never)
    )

    const action = await generateActionProposal(makeConversation())

    expect(proposeAction).toHaveBeenCalledOnce()
    expect(getUserSettings).toHaveBeenCalledWith(TEST_USER_ID)
    expect(updateConversation).toHaveBeenCalledWith(TEST_CONV_ID, { deal_type: 'sale' })
    expect(calculatePriorityScore).toHaveBeenCalledWith(
      expect.objectContaining({
        dollarValue: 8500000, urgency: 7, painFactor: 3,
        offerMultiplier: 1.0, kcFactor: 13, weight: 40,
      })
    )
    expect(createAction).toHaveBeenCalledOnce()
    expect(action).not.toBeNull()
    expect(action!.action_type).toBe('REPLY')
    expect(action!.priority_score).toBe(75)
    expect(action!.queued_for_brief).toBe(true)
    const payload = action!.payload as Record<string, unknown>
    expect(payload.channel).toBe('email')
  })

  it('returns null when CP is blacklisted', async () => {
    const { generateActionProposal } = await import('./planning')

    vi.mocked(getRecentMessages).mockResolvedValue([makeMessage({ cp_id: TEST_CP_ID })])
    vi.mocked(getCPById).mockResolvedValue({ ...testCP, is_blacklisted: true } as never)

    const action = await generateActionProposal(makeConversation())

    expect(action).toBeNull()
    expect(proposeAction).not.toHaveBeenCalled()
  })

  it('clamps weight to 0-100 range', async () => {
    const { generateActionProposal } = await import('./planning')

    vi.mocked(getRecentMessages).mockResolvedValue([makeMessage({ cp_id: TEST_CP_ID })])
    vi.mocked(calculatePriorityScore).mockReturnValue(50)
    vi.mocked(createAction).mockImplementation((a) =>
      Promise.resolve({ ...a, status: 'pending', created_at: new Date().toISOString() } as never)
    )
    vi.mocked(proposeAction).mockResolvedValue({
      actionType: 'REPLY', rationale_cs: 'Test', intent_cs: 'Test',
      missingInfo: [], dollarValue: 1000, urgency: 5, painFactor: 2,
      weight: 250, dealType: null,
    } as never)

    await generateActionProposal(makeConversation())

    expect(calculatePriorityScore).toHaveBeenCalledWith(expect.objectContaining({ weight: 100 }))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE 3: Morning Brief — gathers actions, sends email
// ═════════════════════════════════════════════════════════════════════════════

describe('Integration: Morning Brief workflow', () => {
  const makePendingAction = (overrides = {}) => ({
    id: TEST_ACTION_ID, user_id: TEST_USER_ID, cp_id: TEST_CP_ID,
    conversation_id: TEST_CONV_ID, action_type: 'REPLY', status: 'pending',
    rationale: 'Test', rationale_cs: 'Test', intent_cs: 'Odpovědět na poptávku',
    missing_info: [], priority_score: 75, urgency: 7, dollar_value: 8500000,
    pain_factor: 3, weight: 40, offer_multiplier: 1.0,
    payload: { channel: 'email' }, queued_for_brief: true,
    created_at: new Date().toISOString(),
    ...overrides,
  }) as ActionProposal

  it('loads pending actions, enriches with CP data, sends email', async () => {
    const { sendMorningBrief } = await import('./morning-brief')

    vi.mocked(getPendingActionsForBrief).mockResolvedValue([makePendingAction()])

    const result = await sendMorningBrief(TEST_USER_ID, 'morning')

    expect(result).toBe(true)
    expect(getPendingActionsForBrief).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getCPById).toHaveBeenCalledWith(TEST_CP_ID)
    expect(getConversationById).toHaveBeenCalledWith(TEST_CONV_ID)
    expect(sendEmail).toHaveBeenCalledOnce()

    const [userId, emailArgs] = vi.mocked(sendEmail).mock.calls[0]
    expect(userId).toBe(TEST_USER_ID)
    expect(emailArgs.to).toBe('testuser@gmail.com')
    expect(emailArgs.subject).toContain('Mila')
    expect(emailArgs.body).toContain('Jan Novák')
    expect(markActionsNotified).toHaveBeenCalledWith([TEST_ACTION_ID])
  })

  it('skips when user is unsubscribed', async () => {
    const { sendMorningBrief } = await import('./morning-brief')
    vi.mocked(getUserById).mockResolvedValue({ ...testUser, email_unsubscribed: true } as never)

    expect(await sendMorningBrief(TEST_USER_ID)).toBe(false)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('returns true (nothing to send) when no actions pending', async () => {
    const { sendMorningBrief } = await import('./morning-brief')
    vi.mocked(getPendingActionsForBrief).mockResolvedValue([])

    expect(await sendMorningBrief(TEST_USER_ID)).toBe(true)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('caps at 10 actions per brief', async () => {
    const { sendMorningBrief } = await import('./morning-brief')

    const manyActions = Array.from({ length: 15 }, (_, i) =>
      makePendingAction({ id: `action-${i}`, priority_score: 50 + i })
    )
    vi.mocked(getPendingActionsForBrief).mockResolvedValue(manyActions)

    expect(await sendMorningBrief(TEST_USER_ID)).toBe(true)
    expect(sendEmail).toHaveBeenCalledOnce()

    const [, emailArgs] = vi.mocked(sendEmail).mock.calls[0]
    expect(emailArgs.subject).toContain('10')
  })

  it('uses afternoon greeting for afternoon brief type', async () => {
    const { sendMorningBrief } = await import('./morning-brief')
    vi.mocked(getPendingActionsForBrief).mockResolvedValue([makePendingAction()])

    await sendMorningBrief(TEST_USER_ID, 'afternoon')

    expect(sendEmail).toHaveBeenCalledOnce()
    const [, emailArgs] = vi.mocked(sendEmail).mock.calls[0]
    expect(emailArgs.htmlBody).toContain('Dobré odpoledne')
  })

  it('sendAllMorningBriefs processes multiple users with fault isolation', async () => {
    const { sendAllMorningBriefs } = await import('./morning-brief')

    vi.mocked(getUsersDueBrief).mockResolvedValue([
      { id: 'user-a', email: 'a@test.com' } as never,
      { id: 'user-b', email: 'b@test.com' } as never,
    ])
    // user-a works, user-b not found
    vi.mocked(getUserById).mockImplementation(async (id: string) => {
      if (id === 'user-a') return testUser as never
      return null as never
    })
    vi.mocked(getPendingActionsForBrief).mockResolvedValue([])

    const result = await sendAllMorningBriefs('morning')
    expect(result.sent + result.failed).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE 4: Bulk Ingestion — Phase 1 → Phase 2 → Phase 3
// ═════════════════════════════════════════════════════════════════════════════

describe('Integration: Bulk Ingestion pipeline', () => {
  it('runs all 3 phases: fetch → thread → report', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    // Phase 1: inbox + sent
    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([{
        id: 'email-1', from: 'Jan Novák <jan@example.com>', to: ['testuser@gmail.com'],
        subject: 'Zájem', body: 'Mám zájem o byt.', date: new Date('2025-01-15'),
        threadId: 'thread-1', labels: ['INBOX'],
      }])
      .mockResolvedValueOnce([{
        id: 'email-2', from: 'testuser@gmail.com', to: ['jan@example.com'],
        subject: 'Re: Zájem', body: 'Rádi vám pomůžeme.', date: new Date('2025-01-16'),
        threadId: 'thread-1', labels: ['SENT'],
      }])

    // Phase 2: threading (real code runs with mocked DB deps)
    vi.mocked(getUnprocessedMessages)
      .mockResolvedValueOnce([makeMessage({ id: 's1', external_thread_id: 'thread-1' }), makeMessage({ id: 's2', external_thread_id: 'thread-1' })])
      .mockResolvedValueOnce([])
    vi.mocked(findConversationByExternalThread)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeConversation())

    const progress: Record<string, unknown>[] = []
    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'), new Date('2025-02-01'), 500, (p) => progress.push(p))

    expect(result.phase1.stored).toBeGreaterThan(0)
    expect(result.phase2.messagesProcessed).toBeGreaterThan(0)
    expect(generateAndSendBackfillReport).toHaveBeenCalled() // Phase 3 report
    expect(progress.some(p => p.phase === 1)).toBe(true)
    expect(progress.some(p => p.phase === 2)).toBe(true)
    expect(progress.some(p => p.phase === 3)).toBe(true)
  })

  it('skips emails from blocked senders', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([{
        id: 'blocked-1', from: 'noreply@google.com', to: ['testuser@gmail.com'],
        subject: 'Notification', body: 'Automated', date: new Date('2025-01-15'),
        threadId: 'thread-blocked', labels: ['INBOX'],
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
        id: 'promo-1', from: 'shop@store.com', to: ['testuser@gmail.com'],
        subject: '50% off!', body: 'Buy now', date: new Date('2025-01-15'),
        threadId: 'thread-promo', labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
      }])
      .mockResolvedValueOnce([])

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.skippedCategory).toBe(1)
    expect(result.phase1.stored).toBe(0)
  })

  it('returns early when phase 1 has errors and stores 0 emails', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')
    vi.mocked(getUserById).mockResolvedValue(null as never)

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.stored).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(getUnprocessedMessages).not.toHaveBeenCalled()
  })

  it('tracks enrichment success and failure counts', async () => {
    const { runBulkIngestion } = await import('./bulk-ingestion')

    vi.mocked(fetchEmailsPaginated)
      .mockResolvedValueOnce([
        { id: 'ok', from: 'jan@example.com', to: ['testuser@gmail.com'], subject: 'A', body: 'B', date: new Date('2025-01-15'), threadId: 't1', labels: ['INBOX'] },
        { id: 'fail', from: 'petr@example.com', to: ['testuser@gmail.com'], subject: 'C', body: 'D', date: new Date('2025-01-16'), threadId: 't2', labels: ['INBOX'] },
      ])
      .mockResolvedValueOnce([])

    vi.mocked(enrichMessage)
      .mockResolvedValueOnce('Enriched text 1')
      .mockRejectedValueOnce(new Error('AI rate limit'))

    const result = await runBulkIngestion(TEST_USER_ID, new Date('2025-01-01'))

    expect(result.phase1.stored).toBe(2)
    expect(result.phase1.enriched).toBe(1)
    expect(result.phase1.enrichmentFailed).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITE 5: Ingestion + Threading
// ═════════════════════════════════════════════════════════════════════════════

describe('Integration: Ingestion → Threading flow', () => {
  it('fetches emails, classifies, stores with enrichment', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'gmail-1', from: 'Jan Novák <jan@example.com>', to: ['testuser@gmail.com'],
      subject: 'Zájem o byt', body: 'Mám zájem o byt.', date: new Date(),
      threadId: 'thread-1', labels: ['INBOX', 'UNREAD'],
    }])

    const results = await ingestEmailsForUser(TEST_USER_ID)

    expect(results).toHaveLength(1)
    expect(results[0].isActionable).toBe(true)
    expect(classifyEmail).toHaveBeenCalledOnce()
    expect(findOrCreateCP).toHaveBeenCalledWith(TEST_USER_ID, 'jan@example.com', 'Jan Novák')
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      user_id: TEST_USER_ID, cp_id: TEST_CP_ID, direction: 'inbound',
    }))
    expect(enrichMessage).toHaveBeenCalledOnce()
  })

  it('skips non-actionable emails but stores minimal record', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'nl-1', from: 'news@company.com', to: ['testuser@gmail.com'],
      subject: 'Weekly', body: 'Update...', date: new Date(),
      threadId: 'thread-nl', labels: ['INBOX'],
    }])
    vi.mocked(classifyEmail).mockResolvedValue({ isActionable: false, category: 'newsletter', priority: 'low' } as never)

    const results = await ingestEmailsForUser(TEST_USER_ID)

    expect(results).toHaveLength(0)
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      tag_primary: 'non_actionable', raw_text: '', cp_id: null,
    }))
    expect(findOrCreateCP).not.toHaveBeenCalled()
  })

  it('skips blocked senders without calling AI', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'noreply-1', from: 'noreply@google.com', to: ['testuser@gmail.com'],
      subject: 'Security alert', body: 'Someone signed in', date: new Date(),
      threadId: 'thread-nr', labels: ['INBOX'],
    }])

    expect(await ingestEmailsForUser(TEST_USER_ID)).toHaveLength(0)
    expect(classifyEmail).not.toHaveBeenCalled()
  })

  it('skips duplicate emails', async () => {
    const { ingestEmailsForUser } = await import('./ingestion')

    vi.mocked(messageExists).mockResolvedValue(true)
    vi.mocked(fetchUnreadEmails).mockResolvedValue([{
      id: 'dup-1', from: 'jan@example.com', to: ['testuser@gmail.com'],
      subject: 'Test', body: 'Body', date: new Date(),
      threadId: 'thread-dup', labels: ['INBOX'],
    }])

    expect(await ingestEmailsForUser(TEST_USER_ID)).toHaveLength(0)
    expect(classifyEmail).not.toHaveBeenCalled()
  })

  it('threading matches by external thread ID', async () => {
    const { processMessagesForThreading } = await import('./threading')

    const msg = makeMessage({ id: 'match-1', conversation_id: null, external_thread_id: 'existing-thread' })
    const existingConv = makeConversation({ id: 'existing-conv', messages_since_rebuild: 0 })

    vi.mocked(findConversationByExternalThread).mockResolvedValue(existingConv)
    vi.mocked(getConversationById).mockResolvedValue(existingConv)

    const result = await processMessagesForThreading([msg])

    expect(result.has('existing-conv')).toBe(true)
    expect(updateMessage).toHaveBeenCalledWith('match-1', { conversation_id: 'existing-conv' })
    expect(incrementMessageCount).toHaveBeenCalledWith('existing-conv')
  })

  it('threading creates new conversation when no match', async () => {
    const { processMessagesForThreading } = await import('./threading')

    const msg = makeMessage({ id: 'new-1', conversation_id: null, external_thread_id: 'no-match' })
    const newConv = makeConversation({ id: 'new-conv' })

    vi.mocked(findConversationByExternalThread).mockResolvedValue(null)
    vi.mocked(createConversation).mockResolvedValue(newConv as never)
    vi.mocked(getConversationById).mockResolvedValue(newConv)

    const result = await processMessagesForThreading([msg])

    expect(result.size).toBeGreaterThanOrEqual(1)
    expect(createConversation).toHaveBeenCalled()
    expect(updateMessage).toHaveBeenCalledWith('new-1', { conversation_id: 'new-conv' })
  })
})
