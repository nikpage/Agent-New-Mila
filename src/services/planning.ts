import { proposeAction, generateFinalDraft } from '@/lib/ai/gemini'
import type { ProposedAction } from '@/lib/ai/gemini'
import {
  createAction,
  calculatePriorityScore,
} from '@/lib/db/actions'
import { getConversationById, getRecentMessages, updateConversation } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getLatestMessageFromCP } from '@/lib/db/messages'
import { getUserSettings } from '@/lib/db/users'
import { proposeMeeting } from './scheduling'
import { containsHighValueSignals } from '@/config/client'
import {
  VALID_DEAL_TYPES,
} from '@/lib/supabase/types'
import type {
  ActionProposal,
  ConversationThread,
  ConversationSummary,
  DealType,
} from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

/**
 * Validate AI-returned dealType against known values.
 * Returns null for invalid/unknown values instead of storing garbage.
 */
export function validateDealType(value: unknown): DealType {
  if (typeof value !== 'string') return null
  return (VALID_DEAL_TYPES as readonly string[]).includes(value)
    ? (value as DealType)
    : null
}

/**
 * Select offer multiplier based on counterparty role.
 * Sellers get higher multiplier (more commission value).
 */
export function selectOfferMultiplier(
  cpRole: string | null,
  sellerMultiplier: number,
  buyerMultiplier: number
): number {
  return cpRole === 'seller' ? sellerMultiplier : buyerMultiplier
}

export async function generateActionProposal(
  conversation: ConversationThread
): Promise<ActionProposal[]> {
  const summary = conversation.summary_json as unknown as ConversationSummary

  const recentMessages = await getRecentMessages(conversation.id, 10)

  // Find CP from latest message — support both inbound AND outbound
  // Outbound: user sent an email to CP (e.g., proposing a meeting)
  // Inbound: CP sent an email to user
  const latestWithCP = recentMessages
    .filter(m => m.cp_id)
    .pop()

  if (!latestWithCP?.cp_id) return []

  const cp = await getCPById(latestWithCP.cp_id)
  if (!cp || cp.is_blacklisted) return []

  // Detect channel from most recent message
  const lastMessage = recentMessages[recentMessages.length - 1]
  const channel: 'email' | 'whatsapp' = lastMessage?.channel_id === 'whatsapp' ? 'whatsapp' : 'email'

  // Prefer enriched_text (pre-extracted facts), fall back to cleaned_text.
  // Adaptive count: enough messages to reach ~2000 chars of enriched content,
  // minimum 3, maximum 10. Short enrichments (WhatsApp) naturally include
  // more messages; long enrichments (email) include fewer.
  const allFormatted = recentMessages.map(m => ({
    direction: m.direction || 'UNKNOWN',
    text: m.enriched_text || m.cleaned_text || m.raw_text || '',
  }))

  const PLANNING_TARGET_CHARS = 2000
  const PLANNING_MIN_MESSAGES = 3
  let planCharCount = 0
  let planMsgCount = 0
  for (let i = allFormatted.length - 1; i >= 0; i--) {
    planCharCount += allFormatted[i].text.length
    planMsgCount++
    if (planCharCount >= PLANNING_TARGET_CHARS && planMsgCount >= PLANNING_MIN_MESSAGES) break
  }
  planMsgCount = Math.max(planMsgCount, Math.min(PLANNING_MIN_MESSAGES, allFormatted.length))
  const formattedMessages = allFormatted.slice(-planMsgCount)

  try {
    // Get user settings for AI context
    const settings = await getUserSettings(conversation.user_id)

    // Get AI recommendation(s) — may return multiple actions (e.g. REPLY + SCHEDULE)
    const proposals = await proposeAction(summary, formattedMessages, cp.name, settings, channel)

    // Shared context: days ignored, offer multiplier, deal type (same for all actions in this conversation)
    const latestInbound = await getLatestMessageFromCP(conversation.user_id, cp.id)
    const lastContactDate = latestInbound?.timestamp
      ? new Date(latestInbound.timestamp)
      : conversation.last_updated
        ? new Date(conversation.last_updated)
        : new Date()
    const daysIgnored = Math.floor(
      (Date.now() - lastContactDate.getTime()) / (1000 * 60 * 60 * 24)
    )
    const offerMultiplier = selectOfferMultiplier(
      cp.role, settings.offer_multiplier_seller, settings.offer_multiplier_buyer
    )
    const isHighValue = containsHighValueSignals(
      formattedMessages.map(m => m.text).join(' '),
      settings
    )

    // Write deal_type from first proposal that has one
    const firstDealType = proposals.map(p => validateDealType(p.dealType)).find(d => d !== null) ?? null
    if (firstDealType) {
      await updateConversation(conversation.id, { deal_type: firstDealType })
    }

    const createdActions: ActionProposal[] = []

    for (const proposal of proposals) {
      const dealType = validateDealType(proposal.dealType) ?? firstDealType

      // Proactive Calendar: If SCHEDULE action, use full scheduling service
      let schedulingPayload: Record<string, unknown> = {}
      if (proposal.actionType === 'SCHEDULE') {
        try {
          const cpName = cp.name || cp.primary_identifier

          let meetingLocation: string | undefined
          if (proposal.suggestedLocation) {
            meetingLocation = proposal.suggestedLocation
          } else if (cp.locations) {
            const locations = cp.locations as unknown
            if (Array.isArray(locations) && locations.length > 0 && typeof locations[0] === 'string') {
              meetingLocation = locations[0]
            } else if (typeof locations === 'string') {
              meetingLocation = locations
            }
          }

          let preferredDate: Date | undefined
          if (proposal.suggestedTime) {
            try {
              preferredDate = new Date(proposal.suggestedTime)
              if (isNaN(preferredDate.getTime())) {
                preferredDate = undefined
              }
            } catch {
              preferredDate = undefined
            }
          }

          const schedulingResult = await proposeMeeting(
            conversation.user_id,
            cp.id,
            settings.default_meeting_duration,
            meetingLocation,
            preferredDate
          )

          if (schedulingResult.success && schedulingResult.holdEvent) {
            const hold = schedulingResult.holdEvent
            const start = new Date(hold.start_time)
            const end = new Date(hold.end_time)
            const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })
            const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
            const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
            const slotText = `${dateStr}, ${startStr} - ${endStr}`

            proposal.intent_cs = `Navrhla jsem optimální termín pro schůzku s ${cpName} a zablokovala ho ve vašem kalendáři:\n${slotText}${meetingLocation ? `\nMísto: ${meetingLocation}` : ''}\n\nKlikněte na UDĚLAT a já odešlu ${cpName} pozvánku.`
            proposal.missingInfo = []

            if (schedulingResult.conflicts && schedulingResult.conflicts.length > 0) {
              const conflictNote = schedulingResult.conflicts.map(c =>
                `${c.existingEvent.title}: ${c.recommendation === 'move_existing' ? 'navrhuji přesunout' : 'navrhuji alternativní čas'}`
              ).join('; ')
              proposal.intent_cs += `\n\nKonflikty: ${conflictNote}`
            }

            schedulingPayload = {
              hold_event_id: schedulingResult.holdEvent.id,
              gcal_event_id: schedulingResult.gcalEventId,
              start: schedulingResult.holdEvent.start_time,
              end: schedulingResult.holdEvent.end_time,
              location: meetingLocation || null,
              conflicts: schedulingResult.conflicts?.map(c => ({
                event_title: c.existingEvent.title,
                recommendation: c.recommendation,
              })),
            }
          } else {
            proposal.missingInfo.push({
              label: schedulingResult.error || 'V nejbližších 14 dnech nejsou volné termíny v pracovní době. Napište preferovaný čas.',
              value: null,
            })
          }
        } catch (calendarError) {
          console.error('Failed to run scheduling service:', calendarError)
          proposal.missingInfo.push({
            label: 'Kdy byste chtěl/a se sejít? (Napište preferovaný čas)',
            value: null,
          })
        }
      }

      const weight = proposal.weight || 0
      const priorityScore = calculatePriorityScore({
        dollarValue: proposal.dollarValue,
        urgency: proposal.urgency,
        daysIgnored,
        sellerMultiplier: offerMultiplier,
        kcLowValue: settings.kc_low_value,
        kcHighValue: settings.kc_high_value,
        weight,
      })

      const action = await createAction({
        id: uuidv4(),
        user_id: conversation.user_id,
        conversation_id: conversation.id,
        cp_id: cp.id,
        action_type: proposal.actionType,
        intent_cs: proposal.intent_cs,
        rationale_cs: proposal.rationale_cs,
        missing_info: proposal.missingInfo,
        rationale: proposal.rationale_cs,
        priority_score: priorityScore,
        dollar_value: proposal.dollarValue,
        offer_multiplier: offerMultiplier,
        urgency: proposal.urgency,
        weight,
        draft_subject: null,
        draft_body_text: null,
        payload: {
          intent_cs: proposal.intent_cs,
          execution_plan: proposal.rationale_cs,
          required_inputs: proposal.missingInfo,
          channel,
          action_metadata: {
            action_type: proposal.actionType,
            urgency: proposal.urgency,
            dollar_value: proposal.dollarValue,
            offer_multiplier: offerMultiplier,
            weight,
            deal_type: dealType,
            is_high_value: isHighValue,
          },
          ...schedulingPayload,
        },
        queued_for_brief: true,
      })

      createdActions.push(action)
    }

    return createdActions
  } catch (error) {
    console.error('Failed to generate action proposal:', error)
    return []
  }
}

/**
 * Process conversations in parallel with controlled concurrency.
 * Each conversation involves an AI call (proposeAction) so we batch to
 * avoid overwhelming the Gemini rate limit while still being much faster
 * than fully serial processing.
 */
const PLANNING_CONCURRENCY = 5

export async function generateActionsForConversations(
  conversationIds: string[]
): Promise<ActionProposal[]> {
  const actions: ActionProposal[] = []

  for (let i = 0; i < conversationIds.length; i += PLANNING_CONCURRENCY) {
    const chunk = conversationIds.slice(i, i + PLANNING_CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(async (convId) => {
        const conversation = await getConversationById(convId)
        if (!conversation) return null
        return generateActionProposal(conversation)
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        // generateActionProposal now returns an array of actions
        actions.push(...result.value)
      } else if (result.status === 'rejected') {
        console.error('[Planning] Parallel action generation failed:', result.reason)
      }
    }
  }

  return actions
}

export async function regenerateDraft(
  actionId: string,
  userIntent: string
): Promise<{ subject: string; body: string }> {
  const action = await import('@/lib/db/actions').then(m => m.getActionById(actionId))
  if (!action) throw new Error(`Action ${actionId} not found`)

  const conversation = await getConversationById(action.conversation_id)
  if (!conversation) throw new Error(`Conversation ${action.conversation_id} not found`)

  const cp = await getCPById(action.cp_id)
  const settings = await getUserSettings(action.user_id)

  const channel = ((action.payload as Record<string, unknown>)?.channel as 'email' | 'whatsapp') || 'email'

  return generateFinalDraft(
    conversation.summary_json,
    userIntent || action.intent_cs || action.rationale_cs || action.rationale,
    settings,
    undefined,
    (action.missing_info as { label: string; value: string | null }[] | null) || undefined,
    cp?.name || cp?.primary_identifier || undefined,
    channel
  )
}
