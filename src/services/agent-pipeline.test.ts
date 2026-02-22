/**
 * Agent Pipeline Integration Tests
 *
 * Tests that runAgentForUser correctly chains services together:
 * ingest → thread → plan → lead track.
 *
 * Strategy: mock all service modules as boundaries, verify the agent
 * orchestrator passes data between them correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ActionProposal, ConversationThread, Message } from '@/lib/supabase/types'

const TEST_USER_ID = 'user-pipeline-1'
const TEST_CP_ID = 'cp-pipeline-1'
const TEST_CONV_ID = 'conv-pipeline-1'
const TEST_ACTION_ID = 'action-pipeline-1'

const testUser = {
  id: TEST_USER_ID,
  email: 'pipeline@gmail.com',
  google_oauth_tokens: { access_token: 'valid-token' },
}

function makeMessage(overrides = {}): Message {
  return {
    id: 'msg-1', user_id: TEST_USER_ID, cp_id: TEST_CP_ID, channel_id: 'email',
    thread_id: null, conversation_id: null, external_thread_id: 'thread-1',
    universal_message_id: 'gmail-1', external_id: 'gmail-1', direction: 'inbound',
    raw_text: 'Zájem o byt.', cleaned_text: 'Zájem o byt.', enriched_text: 'Enriched',
    message_type: null, tag_primary: 'inquiry', tag_secondary: 'high',
    timestamp: new Date().toISOString(), occurred_at: new Date().toISOString(),
    ...overrides,
  } as Message
}

function makeConversation(overrides = {}): ConversationThread {
  return {
    id: TEST_CONV_ID, user_id: TEST_USER_ID, topic: 'Byt Vinohrady',
    summary_text: 'Zájem', summary_json: {}, summary_confidence: 0.8,
    messages_since_rebuild: 0, message_count: 3, state: 'active',
    deal_type: 'sale', priority_score: 50, embedding: null,
    last_updated: new Date().toISOString(), created_at: new Date().toISOString(),
    ...overrides,
  } as ConversationThread
}

// Mock ALL dependencies of agent.ts
vi.mock('./ingestion', () => ({
  ingestEmailsForUser: vi.fn(),
  ingestOutboundEmails: vi.fn(),
}))

vi.mock('./threading', () => ({
  processMessagesForThreading: vi.fn(),
}))

vi.mock('./planning', () => ({
  generateActionsForConversations: vi.fn(),
}))

vi.mock('./calendar-ingestion', () => ({
  ingestCalendarEvents: vi.fn(),
}))

vi.mock('./lead-tracking', () => ({
  trackLeadsForUser: vi.fn(),
}))

vi.mock('@/lib/db/messages', () => ({
  getUnprocessedMessages: vi.fn(),
}))

vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn(),
}))

vi.mock('@/lib/db/counterparties', () => ({
  purgeUserAsCp: vi.fn(),
}))

vi.mock('@/lib/db/locks', () => ({
  tryAcquireUserLock: vi.fn(),
  releaseUserLock: vi.fn(),
}))

vi.mock('@/lib/ai/runner', () => ({
  probeAIAvailability: vi.fn(),
}))

// Static imports (vi.mock hoisted above)
import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { processMessagesForThreading } from './threading'
import { generateActionsForConversations } from './planning'
import { ingestCalendarEvents } from './calendar-ingestion'
import { trackLeadsForUser } from './lead-tracking'
import { getUnprocessedMessages } from '@/lib/db/messages'
import { getUserById } from '@/lib/db/users'
import { purgeUserAsCp } from '@/lib/db/counterparties'
import { tryAcquireUserLock, releaseUserLock } from '@/lib/db/locks'
import { probeAIAvailability } from '@/lib/ai/runner'
import { runAgentForUser } from './agent'

beforeEach(() => {
  vi.clearAllMocks()

  // Defaults
  vi.mocked(getUserById).mockResolvedValue(testUser as never)
  vi.mocked(tryAcquireUserLock).mockResolvedValue(true)
  vi.mocked(releaseUserLock).mockResolvedValue(undefined as never)
  vi.mocked(purgeUserAsCp).mockResolvedValue(0 as never)
  vi.mocked(probeAIAvailability).mockResolvedValue(undefined)
  vi.mocked(ingestEmailsForUser).mockResolvedValue([])
  vi.mocked(ingestOutboundEmails).mockResolvedValue(0)
  vi.mocked(ingestCalendarEvents).mockResolvedValue({
    eventsSynced: 0, invitationsDetected: 0, actionsCreated: 0, errors: [],
  } as never)
  vi.mocked(getUnprocessedMessages).mockResolvedValue([])
  vi.mocked(processMessagesForThreading).mockResolvedValue(new Map())
  vi.mocked(generateActionsForConversations).mockResolvedValue([])
  vi.mocked(trackLeadsForUser).mockResolvedValue({
    conversationsScanned: 0, coolingLeads: 0, coldLeads: 0, deadLeads: 0,
    followUpsCreated: 0, errors: [],
  } as never)
})

describe('Agent Pipeline: data flows between steps', () => {
  it('emails ingested in step 2 flow through to steps 3-5', async () => {
    const ingestedEmail = makeMessage({ id: 'ingested-1' })
    vi.mocked(ingestEmailsForUser).mockResolvedValue([{
      id: 'ingested-1',
      email: { id: 'gmail-1', from: 'Jan <jan@ex.com>', to: ['test@gmail.com'], subject: 'Byt', body: 'Zájem', date: new Date(), threadId: 'thread-1', labels: ['INBOX'] },
      cpId: TEST_CP_ID, isActionable: true, category: 'inquiry', priority: 'high',
    }])

    // Step 3: unprocessed messages include the one just ingested
    vi.mocked(getUnprocessedMessages).mockResolvedValue([ingestedEmail])

    // Step 4: threading returns a conversation
    const convMap = new Map([[TEST_CONV_ID, makeConversation()]])
    vi.mocked(processMessagesForThreading).mockResolvedValue(convMap)

    // Step 5: planning generates an action
    const mockAction = {
      id: TEST_ACTION_ID, user_id: TEST_USER_ID, cp_id: TEST_CP_ID,
      conversation_id: TEST_CONV_ID, action_type: 'REPLY', status: 'pending',
      priority_score: 42,
    } as ActionProposal
    vi.mocked(generateActionsForConversations).mockResolvedValue([mockAction])

    const result = await runAgentForUser(TEST_USER_ID)

    expect(result.success).toBe(true)
    expect(result.emailsIngested).toBeGreaterThan(0)
    expect(result.messagesProcessed).toBe(1)
    expect(result.conversationsUpdated).toBe(1)
    expect(result.actionsGenerated).toBeGreaterThanOrEqual(1)

    // Threading received the unprocessed messages from step 3
    expect(processMessagesForThreading).toHaveBeenCalledWith([ingestedEmail])
    // Planning received the conversation IDs from step 4
    expect(generateActionsForConversations).toHaveBeenCalledWith([TEST_CONV_ID])
  })

  it('calendar + lead tracking results aggregate into final result', async () => {
    vi.mocked(ingestCalendarEvents).mockResolvedValue({
      eventsSynced: 5, invitationsDetected: 2, actionsCreated: 1, errors: [],
    } as never)
    vi.mocked(trackLeadsForUser).mockResolvedValue({
      conversationsScanned: 10, coolingLeads: 2, coldLeads: 1, deadLeads: 0,
      followUpsCreated: 3, errors: [],
    } as never)

    const result = await runAgentForUser(TEST_USER_ID)

    expect(result.success).toBe(true)
    expect(result.calendarEventsSynced).toBe(5)
    expect(result.calendarInvitationsDetected).toBe(2)
    expect(result.coolingLeads).toBe(2)
    expect(result.coldLeads).toBe(1)
    expect(result.followUpsGenerated).toBe(3)
    expect(result.actionsGenerated).toBe(1 + 3)
  })

  it('step 2 failures do not prevent steps 3-6 from running', async () => {
    vi.mocked(ingestEmailsForUser).mockRejectedValue(new Error('Gmail token expired'))
    vi.mocked(ingestOutboundEmails).mockRejectedValue(new Error('Gmail token expired'))

    const result = await runAgentForUser(TEST_USER_ID)

    expect(result.success).toBe(true)
    expect(trackLeadsForUser).toHaveBeenCalledWith(TEST_USER_ID)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
    expect(result.errors.some(e => e.includes('Email ingestion'))).toBe(true)
    expect(result.errors.some(e => e.includes('Outbound ingestion'))).toBe(true)
  })

  it('skips steps 4-5 when no unprocessed messages exist', async () => {
    vi.mocked(getUnprocessedMessages).mockResolvedValue([])

    const result = await runAgentForUser(TEST_USER_ID)

    expect(result.success).toBe(true)
    expect(result.messagesProcessed).toBe(0)
    expect(processMessagesForThreading).not.toHaveBeenCalled()
    expect(generateActionsForConversations).not.toHaveBeenCalled()
  })

  it('WhatsApp messages are counted separately from email', async () => {
    vi.mocked(getUnprocessedMessages).mockResolvedValue([
      makeMessage({ id: 'email-1', channel_id: 'email' }),
      makeMessage({ id: 'wa-1', channel_id: 'whatsapp' }),
      makeMessage({ id: 'wa-2', channel_id: 'whatsapp' }),
    ])

    const convMap = new Map([[TEST_CONV_ID, makeConversation()]])
    vi.mocked(processMessagesForThreading).mockResolvedValue(convMap)

    const result = await runAgentForUser(TEST_USER_ID)

    expect(result.messagesProcessed).toBe(3)
    expect(result.whatsappMessagesProcessed).toBe(2)
  })
})
