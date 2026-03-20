import { proposeAction } from '@/lib/ai/gemini'
import { generateFinalDraft } from '@/lib/ai/mila-voice'
import {
  createAction,
  calculatePriorityScore,
  getPendingActionTypes,
} from '@/lib/db/actions'
import { getConversationById, getRecentMessages, updateConversation } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getLatestMessageFromCP } from '@/lib/db/messages'
import { getUserSettings } from '@/lib/db/users'
import { geocodeAddress } from '@/lib/google/maps'
import { containsHighValueSignals } from '@/config/client'
import { selectOfferMultiplier, computeDaysIgnored } from '@/shared/scoring'
import { validateDealType } from '@/shared/deal-types'
import type {
  ActionProposal,
  ConversationThread,
  ConversationSummary,
} from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

/**
 * Validate a meeting location string.
 * Always geocodes — returns the full formatted address (adds city, street etc.).
 * If geocoding fails, keeps raw text but flags for user confirmation.
 */
export async function validateMeetingLocation(
  raw: string
): Promise<{ location: string | undefined; needsConfirmation: boolean }> {
  try {
    const result = await geocodeAddress(raw)
    if (result) {
      return { location: result.formattedAddress, needsConfirmation: false }
    }
  } catch {
    // Geocode failed — fall through
  }

  // Geocode couldn't resolve — keep raw text but ask user to confirm
  return { location: raw, needsConfirmation: true }
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

    // Get AI recommendations — one or more actions per conversation
    const proposals = await proposeAction(summary, formattedMessages, cp.name, settings, channel)

    const latestInbound = await getLatestMessageFromCP(conversation.user_id, cp.id)
    const daysIgnored = computeDaysIgnored(latestInbound?.timestamp, conversation.created_at)
    const offerMultiplier = selectOfferMultiplier(
      cp.role, settings.offer_multiplier_seller, settings.offer_multiplier_buyer
    )
    const isHighValue = containsHighValueSignals(
      formattedMessages.map(m => m.text).join(' '),
      settings
    )

    const createdActions: ActionProposal[] = []

    // Filter out action types that already have pending actions for this conversation
    const existingPendingTypes = await getPendingActionTypes(conversation.id)

    // Dedup: max one of each actionType per conversation per run, and skip already-pending types
    const seenTypes = new Set<string>()
    const dedupedProposals = proposals.filter(p => {
      if (existingPendingTypes.has(p.actionType)) return false
      if (seenTypes.has(p.actionType)) return false
      seenTypes.add(p.actionType)
      return true
    })

    // SCHEDULE absorbs REPLY: when both exist, merge REPLY content into SCHEDULE
    // The calendar invite IS the reply — there should never be a separate REPLY alongside SCHEDULE
    const hasSchedule = dedupedProposals.some(p => p.actionType === 'SCHEDULE')
    const replyIndex = dedupedProposals.findIndex(p => p.actionType === 'REPLY')
    if (hasSchedule && replyIndex !== -1) {
      const scheduleProposal = dedupedProposals.find(p => p.actionType === 'SCHEDULE')!
      const replyProposal = dedupedProposals[replyIndex]
      // Merge REPLY's missingInfo into SCHEDULE (CP questions to answer in the invite)
      if (replyProposal.missingInfo?.length) {
        scheduleProposal.missingInfo = [
          ...(scheduleProposal.missingInfo || []),
          ...replyProposal.missingInfo,
        ]
      }
      // Append REPLY intent to SCHEDULE intent if it adds new info
      if (replyProposal.intent_cs && !scheduleProposal.intent_cs?.includes(replyProposal.intent_cs)) {
        scheduleProposal.intent_cs = `${scheduleProposal.intent_cs} ${replyProposal.intent_cs}`
      }
      // Remove the REPLY
      dedupedProposals.splice(replyIndex, 1)
      console.log(`[Planning] Merged REPLY into SCHEDULE — calendar invite is the reply`)
    }

    for (const proposal of dedupedProposals) {
      // Validate and write deal_type onto conversation thread if AI classified it
      const dealType = validateDealType(proposal.dealType)
      if (dealType) {
        await updateConversation(conversation.id, { deal_type: dealType })
      }

      // SCHEDULE actions: store AI's scheduling context for the batch optimizer.
      // Planning decides WHAT (this conversation needs a meeting).
      // The optimizer decides WHEN (assigns slots in one batch pass at brief time).
      // No holds created here — prevents race conditions from parallel planning.
      let schedulingPayload: Record<string, unknown> = {}
      if (proposal.actionType === 'SCHEDULE') {
        const proposedMeetingType = proposal.meetingType || 'address'
        const isRemoteMeeting = proposedMeetingType === 'phone' || proposedMeetingType === 'online'

        let meetingLocation: string | undefined
        if (!isRemoteMeeting) {
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
        }

        // Validate location via geocode if we have one
        let locationPartial = false
        if (meetingLocation) {
          const validated = await validateMeetingLocation(meetingLocation)
          meetingLocation = validated.location
          locationPartial = validated.needsConfirmation
        }

        // Address confidence handling:
        // - AI said 'low' confidence → flag for user verification even if geocode succeeded
        // - No location at all → add missing_info asking user for the address
        const aiLocationConfidence = proposal.locationConfidence || null
        if (aiLocationConfidence === 'low' && meetingLocation) {
          // Geocode may have succeeded but the AI wasn't sure this is the right place.
          // Flag as partial so user sees the verification prompt in EditForm.
          locationPartial = true
        }

        // Only ask for address if this is an in-person meeting
        if (!isRemoteMeeting && !meetingLocation) {
          // No location found at all — inject a missing_info field asking the user.
          // The 'adresa' keyword in the label is what EditForm uses to render it as a location field.
          const hasAddressField = proposal.missingInfo?.some(f => f.label.toLowerCase().includes('adresa'))
          if (!hasAddressField) {
            proposal.missingInfo = [
              ...(proposal.missingInfo || []),
              { label: 'Kde se schůzka koná? (adresa nebo Online)', value: null },
            ]
          }
        }

        schedulingPayload = {
          suggestedTime: proposal.suggestedTime || null,
          suggestedLocation: meetingLocation || null,
          location_partial: locationPartial,
          cp_availability: (proposal as Record<string, unknown>).cpAvailability as string || null,
          duration: settings.default_meeting_duration,
          meeting_type: proposedMeetingType,
          is_online: proposedMeetingType === 'online',
          cp_phone: proposal.cpPhone || null,
        }
      }

      const weight = proposal.weight || 0
      const priorityScore = calculatePriorityScore({
        dollarValue: proposal.dollarValue,
        urgency: proposal.urgency,
        daysIgnored,
        sellerMultiplier: offerMultiplier,
        kcHighValue: settings.kc_high_value,
        weight,
      })

      // Repair 3: log urgent actions for visibility
      if (proposal.urgency >= 9) {
        console.log(`[Planning] URGENT action created: urgency=${proposal.urgency}, type=${proposal.actionType}, cp=${cp.name || cp.primary_identifier}`)
      }

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
            is_high_value: isHighValue || proposal.dollarValue > settings.kc_high_value,
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
