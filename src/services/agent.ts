/**
 * Main Agent Service
 * Orchestrates the full processing pipeline
 */

import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { processMessagesForThreading } from './threading'
import { generateActionsForConversations } from './planning'
import { ingestCalendarEvents } from './calendar-ingestion'
import { getUnprocessedMessages } from '@/lib/db/messages'
import { getUserById } from '@/lib/db/users'
import type { ActionProposal } from '@/lib/supabase/types'

export interface AgentRunResult {
  success: boolean
  emailsIngested: number
  calendarEventsSynced: number
  calendarInvitationsDetected: number
  messagesProcessed: number
  conversationsUpdated: number
  actionsGenerated: number
  actions: ActionProposal[]
  errors: string[]
}

/**
 * Run the full agent pipeline for a user
 */
export async function runAgentForUser(userId: string): Promise<AgentRunResult> {
  const result: AgentRunResult = {
    success: false,
    emailsIngested: 0,
    calendarEventsSynced: 0,
    calendarInvitationsDetected: 0,
    messagesProcessed: 0,
    conversationsUpdated: 0,
    actionsGenerated: 0,
    actions: [],
    errors: [],
  }

  try {
    // Step 1: Verify user exists and has credentials
    const user = await getUserById(userId)
    if (!user) {
      result.errors.push('User not found')
      return result
    }

    if (!user.google_oauth_tokens) {
      result.errors.push('User has no Google credentials')
      return result
    }

    // Step 2: Ingest new emails (inbound)
    console.log(`[Agent] Ingesting emails for user ${userId}`)
    const ingestedMessages = await ingestEmailsForUser(userId)
    result.emailsIngested = ingestedMessages.length

    // Step 2.1: Ingest outbound emails (detect user-initiated meeting proposals)
    console.log(`[Agent] Ingesting outbound emails for user ${userId}`)
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // last 24 hours
      const outboundCount = await ingestOutboundEmails(userId, since)
      result.emailsIngested += outboundCount
    } catch (outboundError) {
      console.error('[Agent] Outbound email ingestion error:', outboundError)
      result.errors.push(`Outbound ingestion: ${outboundError instanceof Error ? outboundError.message : 'Unknown error'}`)
    }

    // Step 2.5: Ingest calendar events and detect invitations
    console.log(`[Agent] Ingesting calendar events for user ${userId}`)
    try {
      const calendarResult = await ingestCalendarEvents(userId)
      result.calendarEventsSynced = calendarResult.eventsSynced
      result.calendarInvitationsDetected = calendarResult.invitationsDetected
      result.actionsGenerated += calendarResult.actionsCreated
      if (calendarResult.errors.length > 0) {
        result.errors.push(...calendarResult.errors)
      }
    } catch (calendarError) {
      console.error('[Agent] Calendar ingestion error:', calendarError)
      result.errors.push(`Calendar ingestion: ${calendarError instanceof Error ? calendarError.message : 'Unknown error'}`)
    }

    // Step 3: Get all unprocessed messages (including newly ingested)
    const unprocessedMessages = await getUnprocessedMessages(userId)
    result.messagesProcessed = unprocessedMessages.length

    // Step 4: Process messages into conversations
    if (unprocessedMessages.length > 0) {
      console.log(`[Agent] Processing ${unprocessedMessages.length} messages into conversations`)
      const conversations = await processMessagesForThreading(unprocessedMessages)
      result.conversationsUpdated = conversations.size

      // Step 5: Generate action proposals for updated conversations
      const conversationIds = Array.from(conversations.keys())
      console.log(`[Agent] Generating actions for ${conversationIds.length} conversations`)

      const actions = await generateActionsForConversations(conversationIds)
      result.actionsGenerated = actions.length
      result.actions = actions
    }

    result.success = true
  } catch (error) {
    console.error('[Agent] Error:', error)
    result.errors.push(error instanceof Error ? error.message : 'Unknown error')
  }

  return result
}

/**
 * Run the agent for all active users
 */
export async function runAgentForAllUsers(): Promise<Map<string, AgentRunResult>> {
  const results = new Map<string, AgentRunResult>()

  // This would get all users with email enabled and run the agent for each
  // For now, this is a placeholder

  return results
}
