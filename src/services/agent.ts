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
import { probeAIAvailability } from '@/lib/ai/runner'
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

const runningUsers = new Map<string, true>()

/**
 * Run the full agent pipeline for a user
 */
export async function runAgentForUser(userId: string): Promise<AgentRunResult> {
  const emptyResult: AgentRunResult = {
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

  if (runningUsers.has(userId)) {
    console.warn(`[Agent] Skipping — pipeline already running for ${userId}`)
    return emptyResult
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
    console.log(`[Agent] Step 1: Verifying user credentials`)
    const user = await getUserById(userId)
    if (!user) {
      console.log(`[Agent] Step 1: FAILED — user not found`)
      result.errors.push('User not found')
      return result
    }

    if (!user.google_oauth_tokens) {
      console.log(`[Agent] Step 1: FAILED — no Google credentials`)
      result.errors.push('User has no Google credentials')
      return result
    }
    console.log(`[Agent] Step 1: OK — user ${user.email || userId} verified`)

    // Probe AI availability once — skip Gemini if it's geo-blocked
    await probeAIAvailability()

    // Step 0: The user is NOT a counterparty. Purge any bad rows.
    try {
      console.log(`[Agent] Step 0: Purging user-as-counterparty rows`)
      await purgeUserAsCp(userId)
    } catch (purgeError) {
      console.error('[Agent] Step 0: Purge error:', purgeError)
      result.errors.push(`Purge: ${purgeError instanceof Error ? purgeError.message : 'Unknown error'}`)
    }

    // Steps 2, 2.1, 2.5 are INDEPENDENT ingestion steps — run in parallel.
    // Inbound emails, outbound emails, and calendar sync don't depend on each other.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // last 24 hours

    console.log(`[Agent] Steps 2/2.1/2.5: Ingesting emails + calendar (parallel)`)
    const parallelStart = Date.now()
    const [inboundResult, outboundResult, calendarResult] = await Promise.allSettled([
      ingestEmailsForUser(userId),
      ingestOutboundEmails(userId, since),
      ingestCalendarEvents(userId),
    ])
    const parallelMs = Date.now() - parallelStart

    // Collect inbound results
    if (inboundResult.status === 'fulfilled') {
      result.emailsIngested = inboundResult.value.length
      console.log(`[Agent] Step 2:   Inbound emails ingested: ${inboundResult.value.length}`)
    } else {
      console.error('[Agent] Step 2:   Inbound email ingestion FAILED:', inboundResult.reason instanceof Error ? inboundResult.reason.message : inboundResult.reason)
      result.errors.push(`Email ingestion: ${inboundResult.reason instanceof Error ? inboundResult.reason.message : 'Unknown error'}`)
    }

    // Collect outbound results
    if (outboundResult.status === 'fulfilled') {
      result.emailsIngested += outboundResult.value
      console.log(`[Agent] Step 2.1: Outbound emails ingested: ${outboundResult.value}`)
    } else {
      console.error('[Agent] Step 2.1: Outbound email ingestion FAILED:', outboundResult.reason instanceof Error ? outboundResult.reason.message : outboundResult.reason)
      result.errors.push(`Outbound ingestion: ${outboundResult.reason instanceof Error ? outboundResult.reason.message : 'Unknown error'}`)
    }

    // Collect calendar results
    if (calendarResult.status === 'fulfilled') {
      result.calendarEventsSynced = calendarResult.value.eventsSynced
      result.calendarInvitationsDetected = calendarResult.value.invitationsDetected
      result.actionsGenerated += calendarResult.value.actionsCreated
      console.log(`[Agent] Step 2.5: Calendar synced: ${calendarResult.value.eventsSynced} events, ${calendarResult.value.invitationsDetected} invitations`)
      if (calendarResult.value.errors.length > 0) {
        result.errors.push(...calendarResult.value.errors)
      }
    } else {
      console.error('[Agent] Step 2.5: Calendar ingestion FAILED:', calendarResult.reason instanceof Error ? calendarResult.reason.message : calendarResult.reason)
      result.errors.push(`Calendar ingestion: ${calendarResult.reason instanceof Error ? calendarResult.reason.message : 'Unknown error'}`)
    }
    console.log(`[Agent] Steps 2/2.1/2.5 completed in ${(parallelMs / 1000).toFixed(1)}s`)

    // Step 3: Get all unprocessed messages (including newly ingested + WhatsApp)
    // Steps 3-5 depend on each other but are isolated from steps 2/2.5/6
    try {
      console.log(`[Agent] Step 3: Loading unprocessed messages`)
      const unprocessedMessages = await getUnprocessedMessages(userId)
      result.messagesProcessed = unprocessedMessages.length
      result.whatsappMessagesProcessed = unprocessedMessages.filter(
        m => m.channel_id === 'whatsapp'
      ).length
      console.log(`[Agent] Step 3: Found ${unprocessedMessages.length} unprocessed (${result.whatsappMessagesProcessed} WhatsApp)`)

      // Step 4: Process messages into conversations
      if (unprocessedMessages.length > 0) {
        console.log(`[Agent] Step 4: Threading messages into conversations`)
        const conversations = await processMessagesForThreading(unprocessedMessages)
        result.conversationsUpdated = conversations.size
        console.log(`[Agent] Step 4: Threaded into ${conversations.size} conversations`)

        // Step 5: Generate action proposals for updated conversations
        const conversationIds = Array.from(conversations.keys())
        console.log(`[Agent] Step 5: Generating action proposals for ${conversationIds.length} conversations`)
        const actions = await generateActionsForConversations(conversationIds)
        result.actionsGenerated += actions.length
        result.actions = actions
        console.log(`[Agent] Step 5: Generated ${actions.length} actions`)
      } else {
        console.log(`[Agent] Steps 4-5: Skipped — no unprocessed messages`)
      }
    } catch (processingError) {
      console.error('[Agent] Steps 3-5 FAILED:', processingError instanceof Error ? processingError.message : processingError)
      result.errors.push(`Processing: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`)
    }

    // Step 6: Lead tracking — detect cooling/cold leads, create follow-up actions
    try {
      console.log(`[Agent] Step 6: Tracking leads`)
      const leadResult = await trackLeadsForUser(userId)
      result.followUpsGenerated = leadResult.followUpsCreated
      result.coolingLeads = leadResult.coolingLeads
      result.coldLeads = leadResult.coldLeads
      result.actionsGenerated += leadResult.followUpsCreated
      console.log(`[Agent] Step 6: ${leadResult.coolingLeads} cooling, ${leadResult.coldLeads} cold, ${leadResult.followUpsCreated} follow-ups created`)
      if (leadResult.errors.length > 0) {
        result.errors.push(...leadResult.errors)
      }
    } catch (leadError) {
      console.error('[Agent] Step 6 FAILED:', leadError instanceof Error ? leadError.message : leadError)
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
