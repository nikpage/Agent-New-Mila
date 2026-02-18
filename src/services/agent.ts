/**
 * Main Agent Service
 * Orchestrates the full processing pipeline
 */

import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { processMessagesForThreading } from './threading'
import { generateActionsForConversations } from './planning'
import { ingestCalendarEvents } from './calendar-ingestion'
import { trackLeadsForUser } from './lead-tracking'
import { getUnprocessedMessages } from '@/lib/db/messages'
import { getUserById } from '@/lib/db/users'
import { purgeUserAsCp } from '@/lib/db/counterparties'
import type { ActionProposal } from '@/lib/supabase/types'

export interface AgentRunResult {
  success: boolean
  emailsIngested: number
  whatsappMessagesProcessed: number
  calendarEventsSynced: number
  calendarInvitationsDetected: number
  messagesProcessed: number
  conversationsUpdated: number
  actionsGenerated: number
  followUpsGenerated: number
  coolingLeads: number
  coldLeads: number
  actions: ActionProposal[]
  errors: string[]
}

/**
 * Per-user concurrency lock.
 * Prevents two simultaneous agent runs for the same user (e.g. cron + email-open
 * or double cron fire) which would cause duplicate messages, CPs, and actions.
 *
 * Key = userId, Value = true while running.
 * In-memory is fine: Vercel serverless can't share state across instances,
 * so the worst case is two cold-start instances both run — but that's far
 * better than the current situation where EVERY concurrent call runs.
 */
const runningUsers = new Map<string, true>()

/**
 * Run the full agent pipeline for a user
 */
export async function runAgentForUser(userId: string): Promise<AgentRunResult> {
  // Per-user concurrency guard
  if (runningUsers.has(userId)) {
    console.warn(`[Agent] Skipping — pipeline already running for ${userId}`)
    return {
      success: true,
      emailsIngested: 0,
      whatsappMessagesProcessed: 0,
      calendarEventsSynced: 0,
      calendarInvitationsDetected: 0,
      messagesProcessed: 0,
      conversationsUpdated: 0,
      actionsGenerated: 0,
      followUpsGenerated: 0,
      coolingLeads: 0,
      coldLeads: 0,
      actions: [],
      errors: ['Skipped — concurrent run already in progress'],
    }
  }

  runningUsers.set(userId, true)

  const result: AgentRunResult = {
    success: false,
    emailsIngested: 0,
    whatsappMessagesProcessed: 0,
    calendarEventsSynced: 0,
    calendarInvitationsDetected: 0,
    messagesProcessed: 0,
    conversationsUpdated: 0,
    actionsGenerated: 0,
    followUpsGenerated: 0,
    coolingLeads: 0,
    coldLeads: 0,
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

    // Step 0: The user is NOT a counterparty. Purge any bad rows.
    await purgeUserAsCp(userId)

    // Step 2: Ingest new emails (inbound)
    const ingestedMessages = await ingestEmailsForUser(userId)
    result.emailsIngested = ingestedMessages.length

    // Step 2.1: Ingest outbound emails (detect user-initiated meeting proposals)
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // last 24 hours
      const outboundCount = await ingestOutboundEmails(userId, since)
      result.emailsIngested += outboundCount
    } catch (outboundError) {
      console.error('[Agent] Outbound email ingestion error:', outboundError)
      result.errors.push(`Outbound ingestion: ${outboundError instanceof Error ? outboundError.message : 'Unknown error'}`)
    }

    // Step 2.5: Ingest calendar events and detect invitations
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

    // Step 3: Get all unprocessed messages (including newly ingested + WhatsApp)
    const unprocessedMessages = await getUnprocessedMessages(userId)
    result.messagesProcessed = unprocessedMessages.length
    result.whatsappMessagesProcessed = unprocessedMessages.filter(
      m => m.channel_id === 'whatsapp'
    ).length

    // Step 4: Process messages into conversations
    if (unprocessedMessages.length > 0) {
      const conversations = await processMessagesForThreading(unprocessedMessages)
      result.conversationsUpdated = conversations.size

      // Step 5: Generate action proposals for updated conversations
      const conversationIds = Array.from(conversations.keys())
      const actions = await generateActionsForConversations(conversationIds)
      result.actionsGenerated = actions.length
      result.actions = actions
    }

    // Step 6: Lead tracking — detect cooling/cold leads, create follow-up actions
    try {
      const leadResult = await trackLeadsForUser(userId)
      result.followUpsGenerated = leadResult.followUpsCreated
      result.coolingLeads = leadResult.coolingLeads
      result.coldLeads = leadResult.coldLeads
      result.actionsGenerated += leadResult.followUpsCreated
      if (leadResult.errors.length > 0) {
        result.errors.push(...leadResult.errors)
      }
    } catch (leadError) {
      console.error('[Agent] Lead tracking error:', leadError)
      result.errors.push(`Lead tracking: ${leadError instanceof Error ? leadError.message : 'Unknown error'}`)
    }

    result.success = true
  } catch (error) {
    console.error('[Agent] Error:', error)
    result.errors.push(error instanceof Error ? error.message : 'Unknown error')
  } finally {
    runningUsers.delete(userId)
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
