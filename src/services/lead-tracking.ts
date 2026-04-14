/**
 * @deprecated — Chunk 10 cutover. Replaced by graph-walker.ts lead task detection:
 *   lead_cooling / lead_cold / lead_dead tasks are now emitted by walkAllDeals()
 *   and scored by scoreWalkerOutput(). insertCardsAsActions() writes REPLY cards.
 *
 * This file is kept for reference only. Remove after validation period.
 */

/**
 * Lead Tracking Service
 *
 * The core value proposition: don't drop leads.
 *
 * Scans all active conversations and detects:
 * 1. Cooling leads — no activity in X days, gentle follow-up needed
 * 2. Cold leads — no activity in Y days, urgent follow-up
 * 3. Dead leads — no activity in Z days, escalate to user decision
 *
 * Generates REPLY action proposals for follow-ups with
 * priority-boosted scores so they surface at the top.
 */

import { getConversationsForUser, getRecentMessages } from '@/lib/db/conversations'
import { hasPendingAction, createAction, calculatePriorityScore, getActionsForConversation } from '@/lib/db/actions'
import { getCPById } from '@/lib/db/counterparties'
import { getLatestInboundFromCP } from '@/lib/db/timeline'
import { getUserSettings } from '@/lib/db/users'
import { containsHighValueSignals } from '@/config/client'
import { selectOfferMultiplier, computeDaysIgnored } from '@/shared/scoring'
import { generateLeadFollowUpIntent } from '@/lib/ai/mila-voice'
import { buildMilaContext, formatTimelineForPrompt, formatJournalForPrompt } from '@/lib/ai/context'
import { getChannelType } from '@/lib/db/channels'
import type { ActionProposal, ConversationThread, UserSettings } from '@/lib/supabase/types'
import { SERVICE_ROLES } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

export interface LeadTrackingResult {
  conversationsScanned: number
  coolingLeads: number
  coldLeads: number
  deadLeads: number
  followUpsCreated: number
  errors: string[]
}

export type LeadStatus = 'active' | 'cooling' | 'cold' | 'dead'

export function getLeadStatus(daysSinceActivity: number, settings: UserSettings): LeadStatus {
  if (daysSinceActivity >= settings.dead_threshold_days) return 'dead'
  if (daysSinceActivity >= settings.cold_threshold_days) return 'cold'
  if (daysSinceActivity >= settings.cooling_threshold_days) return 'cooling'
  return 'active'
}

/**
 * Count how many follow-up actions have already been created for a conversation.
 * Uses DB query filtered by conversation_id — no limit issues.
 */
async function countExistingFollowUps(
  userId: string,
  conversationId: string
): Promise<number> {
  const actions = await getActionsForConversation(conversationId)
  return actions.filter(a =>
    a.user_id === userId &&
    a.payload &&
    typeof a.payload === 'object' &&
    (a.payload as Record<string, unknown>).is_follow_up === true
  ).length
}

/**
 * Run lead tracking for a user.
 * Scans all conversations, detects cold leads, creates follow-up actions.
 */
export async function trackLeadsForUser(userId: string): Promise<LeadTrackingResult> {
  const result: LeadTrackingResult = {
    conversationsScanned: 0,
    coolingLeads: 0,
    coldLeads: 0,
    deadLeads: 0,
    followUpsCreated: 0,
    errors: [],
  }

  try {
    const settings = await getUserSettings(userId)

    // Get all conversations, ordered by least recently updated
    const conversations = await getConversationsForUser(userId, {
      orderBy: 'last_updated',
    })

    result.conversationsScanned = conversations.length
    console.log(`[LeadTracking] Scanning ${conversations.length} conversations`)

    // Process conversations in parallel batches — each conversation is
    // independent (different CPs, different actions) so safe to parallelize.
    const LEAD_TRACKING_CONCURRENCY = 10

    for (let i = 0; i < conversations.length; i += LEAD_TRACKING_CONCURRENCY) {
      const chunk = conversations.slice(i, i + LEAD_TRACKING_CONCURRENCY)
      const results = await Promise.allSettled(
        chunk.map(conv =>
          processConversationForLeadTracking(conv, userId, result, settings)
        )
      )

      for (const r of results) {
        if (r.status === 'rejected') {
          const msg = r.reason instanceof Error ? r.reason.message : 'Unknown error'
          console.error(`[LeadTracking] Batch error: ${msg}`)
          result.errors.push(
            `Lead tracking: ${msg}`
          )
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[LeadTracking] Fatal error: ${msg}`)
    result.errors.push(msg)
  }

  console.log(`[LeadTracking] Done — ${result.coolingLeads} cooling, ${result.coldLeads} cold, ${result.deadLeads} dead, ${result.followUpsCreated} follow-ups created`)
  return result
}

async function processConversationForLeadTracking(
  conversation: ConversationThread,
  userId: string,
  result: LeadTrackingResult,
  settings: UserSettings
): Promise<void> {
  // Snooze bypass: skip conversations where current date < snooze_until
  if (conversation.snooze_until && new Date() < new Date(conversation.snooze_until)) {
    return
  }

  // Find the counterparty from recent messages
  const recentMessages = await getRecentMessages(conversation.id, 5)
  const latestWithCP = recentMessages.filter(m => m.cp_id).pop()
  if (!latestWithCP?.cp_id) return

  const cp = await getCPById(latestWithCP.cp_id)
  if (!cp || cp.is_blacklisted) return

  // Service CPs don't go cold — skip lead tracking
  if (cp.role && (SERVICE_ROLES as readonly string[]).includes(cp.role)) return

  // Measure days since last INBOUND message from the counterparty,
  // not conversation.last_updated (which resets on every summary rebuild).
  const latestInbound = await getLatestInboundFromCP(userId, cp.id)
  const daysSinceActivity = computeDaysIgnored(latestInbound?.occurred_at, conversation.created_at)

  const status = getLeadStatus(daysSinceActivity, settings)

  // Active leads don't need intervention
  if (status === 'active') return

  const topic = conversation.topic || conversation.id.slice(0, 8)

  // Track counts
  if (status === 'cooling') result.coolingLeads++
  if (status === 'cold') result.coldLeads++
  if (status === 'dead') result.deadLeads++

  console.log(`[LeadTracking] ${status.toUpperCase()} — "${topic}" (${daysSinceActivity}d inactive)`)

  // Skip if there's already a pending action for this conversation
  const hasPending = await hasPendingAction(conversation.id)
  if (hasPending) {
    console.log(`[LeadTracking]   skip — pending action exists`)
    return
  }

  // Check how many follow-ups we've already sent
  const followUpCount = await countExistingFollowUps(userId, conversation.id)
  if (followUpCount >= settings.max_auto_follow_ups) {
    console.log(`[LeadTracking]   skip — max follow-ups reached (${followUpCount}/${settings.max_auto_follow_ups})`)
    return
  }

  // Check if the conversation involves high-value signals
  const conversationText = recentMessages.map(m => m.cleaned_text || m.raw_text || '').join(' ')
  const isHighValue = containsHighValueSignals(conversationText, settings)

  // Select offer multiplier based on counterparty role
  const offerMultiplier = selectOfferMultiplier(
    cp.role, settings.offer_multiplier_seller, settings.offer_multiplier_buyer
  )

  // Calculate priority — no separate boosts, daysIgnored^1.5 handles escalation
  const basePriority = calculatePriorityScore({
    dollarValue: 0, // We don't know deal value from messages alone
    urgency: status === 'dead' ? 9 : status === 'cold' ? 7 : 5,
    daysIgnored: daysSinceActivity,
    sellerMultiplier: offerMultiplier,
    kcHighValue: settings.kc_high_value,
  })

  const boostedPriority = basePriority

  // Determine the channel this conversation is on
  const lastMessage = recentMessages[recentMessages.length - 1]
  const channelType = await getChannelType(lastMessage?.channel_id)
  const channel = channelType === 'whatsapp' ? 'WhatsApp' : 'email'
  const cpName = cp.name || cp.primary_identifier

  // Build Mila context for this lead — journal may know CP went cold before
  let journalNotes: string | undefined
  let lastTimelineText: string | undefined
  try {
    const leadCtx = await buildMilaContext(conversation.id, userId, cp.id, null, 'light')
    journalNotes = formatJournalForPrompt(leadCtx.journal) || undefined
    if (leadCtx.timeline.length > 0) {
      lastTimelineText = formatTimelineForPrompt(leadCtx.timeline.slice(-1))
    }
  } catch { /* context fetch failed — proceed without */ }

  // Build the follow-up intent
  const intent = await generateLeadFollowUpIntent(
    status,
    cpName,
    daysSinceActivity,
    topic,
    channel,
    followUpCount,
    settings,
    journalNotes,
    lastTimelineText
  )

  // Create the follow-up action
  const action = await createAction({
    id: uuidv4(),
    user_id: userId,
    conversation_id: conversation.id,
    cp_id: cp.id,
    action_type: 'REPLY',
    intent_cs: intent.intentCs,
    rationale_cs: intent.rationaleCs,
    missing_info: [],
    rationale: intent.rationaleCs,
    priority_score: boostedPriority,
    dollar_value: 0,
    offer_multiplier: offerMultiplier,
    urgency: status === 'dead' ? 9 : status === 'cold' ? 7 : 5,
    draft_subject: null,
    draft_body_text: null,
    payload: {
      intent_cs: intent.intentCs,
      execution_plan: intent.rationaleCs,
      required_inputs: [],
      action_metadata: {
        action_type: 'REPLY',
        urgency: status === 'dead' ? 9 : status === 'cold' ? 7 : 5,
        dollar_value: 0,
        offer_multiplier: offerMultiplier,
      },
      // Lead tracking metadata
      is_follow_up: true,
      follow_up_number: followUpCount + 1,
      lead_status: status,
      days_since_activity: daysSinceActivity,
      channel,
      is_high_value: isHighValue,
    },
    queued_for_brief: true,
  })

  if (action) {
    result.followUpsCreated++
    console.log(`[LeadTracking]   follow-up #${followUpCount + 1} created for ${cpName} (priority: ${boostedPriority})`)
  }
}
