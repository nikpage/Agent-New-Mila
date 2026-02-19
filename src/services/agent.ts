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
import { tryAcquireUserLock, releaseUserLock } from '@/lib/db/locks'
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
 * In-memory fallback lock — used when the DB-based lock table doesn't exist yet.
 * Once the user_agent_locks migration has been applied, this is only reached
 * if the DB insert itself throws (network error, etc.).
 */
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

  // --- Per-user concurrency guard (DB-level, works across Vercel instances) ---
  let dbLockAcquired = false
  let dbLockAvailable = true // false if the lock table doesn't exist yet

  try {
    dbLockAcquired = await tryAcquireUserLock(userId)
  } catch {
    // DB lock table may not exist yet — fall back to in-memory
    dbLockAvailable = false
    console.warn('[Agent] DB lock unavailable, falling back to in-memory lock')
  }

  if (!dbLockAcquired && dbLockAvailable) {
    // DB lock exists but is held by another instance — skip
    console.warn(`[Agent] Skipping — pipeline already running for ${userId} (cross-instance)`)
    return emptyResult
  }

  // In-memory guard (primary lock when DB is unavailable, secondary when it is)
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
    try {
      await purgeUserAsCp(userId)
    } catch (purgeError) {
      console.error('[Agent] Purge error:', purgeError)
      result.errors.push(`Purge: ${purgeError instanceof Error ? purgeError.message : 'Unknown error'}`)
    }

    // Steps 2, 2.1, 2.5 are INDEPENDENT ingestion steps — run in parallel.
    // Inbound emails, outbound emails, and calendar sync don't depend on each other.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // last 24 hours

    const [inboundResult, outboundResult, calendarResult] = await Promise.allSettled([
      ingestEmailsForUser(userId),
      ingestOutboundEmails(userId, since),
      ingestCalendarEvents(userId),
    ])

    // Collect inbound results
    if (inboundResult.status === 'fulfilled') {
      result.emailsIngested = inboundResult.value.length
    } else {
      console.error('[Agent] Email ingestion error:', inboundResult.reason)
      result.errors.push(`Email ingestion: ${inboundResult.reason instanceof Error ? inboundResult.reason.message : 'Unknown error'}`)
    }

    // Collect outbound results
    if (outboundResult.status === 'fulfilled') {
      result.emailsIngested += outboundResult.value
    } else {
      console.error('[Agent] Outbound email ingestion error:', outboundResult.reason)
      result.errors.push(`Outbound ingestion: ${outboundResult.reason instanceof Error ? outboundResult.reason.message : 'Unknown error'}`)
    }

    // Collect calendar results
    if (calendarResult.status === 'fulfilled') {
      result.calendarEventsSynced = calendarResult.value.eventsSynced
      result.calendarInvitationsDetected = calendarResult.value.invitationsDetected
      result.actionsGenerated += calendarResult.value.actionsCreated
      if (calendarResult.value.errors.length > 0) {
        result.errors.push(...calendarResult.value.errors)
      }
    } else {
      console.error('[Agent] Calendar ingestion error:', calendarResult.reason)
      result.errors.push(`Calendar ingestion: ${calendarResult.reason instanceof Error ? calendarResult.reason.message : 'Unknown error'}`)
    }

    // Step 3: Get all unprocessed messages (including newly ingested + WhatsApp)
    // Steps 3-5 depend on each other but are isolated from steps 2/2.5/6
    try {
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
        result.actionsGenerated += actions.length
        result.actions = actions
      }
    } catch (processingError) {
      console.error('[Agent] Message processing/threading/planning error:', processingError)
      result.errors.push(`Processing: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`)
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
    // Always release both locks
    runningUsers.delete(userId)
    try {
      await releaseUserLock(userId)
    } catch {
      console.error('[Agent] Failed to release DB lock for', userId)
    }
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
