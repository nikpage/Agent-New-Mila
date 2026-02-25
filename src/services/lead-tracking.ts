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
import { hasPendingAction, createAction, calculatePriorityScore, getActionsForUser } from '@/lib/db/actions'
import { getCPById } from '@/lib/db/counterparties'
import { getUserSettings } from '@/lib/db/users'
import { containsHighValueSignals } from '@/config/client'
import { selectOfferMultiplier } from './planning'
import type { ActionProposal, ConversationThread, UserSettings } from '@/lib/supabase/types'
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
 * Looks at completed + pending actions with follow-up indicators in the payload.
 */
async function countExistingFollowUps(
  userId: string,
  conversationId: string
): Promise<number> {
  const actions = await getActionsForUser(userId, { limit: 50 })
  return actions.filter(a =>
    a.conversation_id === conversationId &&
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
          result.errors.push(
            `Lead tracking: ${r.reason instanceof Error ? r.reason.message : 'Unknown error'}`
          )
        }
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : 'Unknown error')
  }

  return result
}

async function processConversationForLeadTracking(
  conversation: ConversationThread,
  userId: string,
  result: LeadTrackingResult,
  settings: UserSettings
): Promise<void> {
  // Calculate days since last activity
  const lastUpdate = conversation.last_updated
    ? new Date(conversation.last_updated)
    : conversation.created_at
      ? new Date(conversation.created_at)
      : new Date()
  const daysSinceActivity = Math.floor(
    (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24)
  )

  const status = getLeadStatus(daysSinceActivity, settings)

  // Active leads don't need intervention
  if (status === 'active') return

  // Track counts
  if (status === 'cooling') result.coolingLeads++
  if (status === 'cold') result.coldLeads++
  if (status === 'dead') result.deadLeads++

  // Skip if there's already a pending action for this conversation
  const hasPending = await hasPendingAction(conversation.id)
  if (hasPending) return

  // Check how many follow-ups we've already sent
  const followUpCount = await countExistingFollowUps(userId, conversation.id)
  if (followUpCount >= settings.max_auto_follow_ups) {
    // Max follow-ups reached — for dead leads, we could create an escalation
    // but for now, just skip. The user will see these in their dashboard.
    return
  }

  // Find the counterparty from recent messages
  const recentMessages = await getRecentMessages(conversation.id, 5)
  const latestWithCP = recentMessages.filter(m => m.cp_id).pop()
  if (!latestWithCP?.cp_id) return

  const cp = await getCPById(latestWithCP.cp_id)
  if (!cp || cp.is_blacklisted) return

  // Check if the conversation involves high-value signals
  const conversationText = recentMessages.map(m => m.cleaned_text || m.raw_text || '').join(' ')
  const isHighValue = containsHighValueSignals(conversationText, settings)

  // Select offer multiplier based on counterparty role
  const offerMultiplier = selectOfferMultiplier(
    cp.role, settings.offer_multiplier_seller, settings.offer_multiplier_buyer
  )

  // Calculate priority with lead-tracking boosts
  const basePriority = calculatePriorityScore({
    dollarValue: 0, // We don't know deal value from messages alone
    urgency: status === 'dead' ? 9 : status === 'cold' ? 7 : 5,
    painFactor: status === 'dead' ? 9 : status === 'cold' ? 7 : 4,
    daysIgnored: daysSinceActivity,
    offerMultiplier,
    kcLowValue: settings.kc_low_value,
    kcHighValue: settings.kc_high_value,
  })

  // Apply lead-status boost
  let priorityBoost = 1.0
  if (status === 'cooling') priorityBoost = settings.cooling_priority_boost
  if (status === 'cold') priorityBoost = settings.cold_priority_boost
  if (status === 'dead') priorityBoost = settings.cold_priority_boost * 1.5
  if (isHighValue) priorityBoost *= 1.5

  const boostedPriority = Math.round(basePriority * priorityBoost)

  // Determine the channel this conversation is on
  const lastMessage = recentMessages[recentMessages.length - 1]
  const channel = lastMessage?.channel_id === 'whatsapp' ? 'WhatsApp' : 'email'
  const cpName = cp.name || cp.primary_identifier

  // Build the follow-up intent
  const intent = buildFollowUpIntent(status, cpName, daysSinceActivity, channel, followUpCount, conversation)

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
    pain_factor: status === 'dead' ? 9 : status === 'cold' ? 7 : 4,
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
        pain_factor: status === 'dead' ? 9 : status === 'cold' ? 7 : 4,
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
  }
}

/**
 * Build human-readable follow-up intent and rationale in Czech.
 */
function buildFollowUpIntent(
  status: LeadStatus,
  cpName: string,
  daysSinceActivity: number,
  channel: string,
  followUpNumber: number,
  conversation: ConversationThread
): { intentCs: string; rationaleCs: string } {
  const topic = conversation.topic || 'konverzace'

  if (status === 'dead') {
    return {
      intentCs: `${cpName} neodpověděl/a už ${daysSinceActivity} dní (téma: ${topic}). Toto je poslední pokus o kontakt. Připravím zdvořilou zprávu přes ${channel} s dotazem, zda je stále zájem, nebo zda mám záležitost uzavřít.`,
      rationaleCs: `Lead je neaktivní ${daysSinceActivity} dní. Bez follow-upu hrozí ztráta obchodu. Toto je follow-up č. ${followUpNumber + 1}.`,
    }
  }

  if (status === 'cold') {
    return {
      intentCs: `${cpName} neodpověděl/a ${daysSinceActivity} dní na téma "${topic}". Připravím follow-up přes ${channel} — připomenu se a nabídnu další kroky.`,
      rationaleCs: `Lead chladne — ${daysSinceActivity} dní bez aktivity. Follow-up č. ${followUpNumber + 1} zabrání ztrátě leadu.`,
    }
  }

  // cooling
  return {
    intentCs: `Konverzace s ${cpName} o "${topic}" ztrácí tempo (${daysSinceActivity} dny). Připravím krátký check-in přes ${channel}.`,
    rationaleCs: `Mírné zpomalení komunikace (${daysSinceActivity} dní). Včasný check-in udrží lead aktivní.`,
  }
}
