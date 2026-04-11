import { triageConversation, verifyTriage, type TriageAction, type TriageResult } from '@/lib/ai/gemini'
import { generateFinalDraft } from '@/lib/ai/mila-voice'
import { buildMilaContext, formatTimelineForPrompt, formatJournalForPrompt } from '@/lib/ai/context'
import {
  createAction,
  updateAction,
  dismissAction,
  calculatePriorityScore,
  getPendingActionsByType,
} from '@/lib/db/actions'
import { hasActiveEventForConversation } from '@/lib/db/events'
import { getConversationById, getRecentMessages, updateConversation } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getLatestInboundFromCP, getTimelineForConversation } from '@/lib/db/timeline'
import { getUserSettings } from '@/lib/db/users'
import { geocodeAddress } from '@/lib/google/maps'
import { containsHighValueSignals } from '@/config/client'
import { selectOfferMultiplier, computeDaysIgnored } from '@/shared/scoring'
import { getChannelType } from '@/lib/db/channels'
import { validateDealType } from '@/shared/deal-types'
import type {
  ActionProposal,
  ConversationThread,
  ConversationSummary,
  UserSettings,
} from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

/**
 * Validate a meeting location string.
 * Always geocodes — returns the full formatted address (adds city, street etc.).
 * If geocoding fails, keeps raw text but flags for user confirmation.
 */
export async function validateMeetingLocation(
  raw: string,
  region?: string
): Promise<{ location: string | undefined; needsConfirmation: boolean }> {
  console.log(`[Planning] Geocoding raw AI location: "${raw}"${region ? ` (region: ${region})` : ''}`)
  try {
    const result = await geocodeAddress(raw, region)
    if (result) {
      console.log(`[Planning] Geocoded: "${raw}" → "${result.formattedAddress}"`)
      return { location: result.formattedAddress, needsConfirmation: false }
    }
  } catch {
    // Geocode failed — fall through
  }

  // Geocode couldn't resolve — keep raw text but ask user to confirm
  console.log(`[Planning] Geocode failed for "${raw}" — keeping raw text`)
  return { location: raw, needsConfirmation: true }
}

/*
 * ADDRESS INFERENCE for SCHEDULE actions — triage now handles venue extraction.
 * suggestedLocation is the MEETING VENUE — WHERE PEOPLE WILL MEET,
 * NOT the property or deal subject unless the meeting is literally at the property.
 * Priority: (1) explicit venue stated in conversation, (2) CP's office from
 * signature if meeting is at their place, (3) user's office if CP says
 * "at your office", (4) property address ONLY if the meeting is literally at the property (e.g. a viewing/inspection).
 * Addresses in email signatures are the SENDER's company address — do not
 * confuse with meeting venue. A conversation about "office space in Karlin"
 * does NOT mean the meeting is in Karlin.
 * ADDRESS INFERENCE for SCHEDULE: triage extracts the MEETING VENUE, not the property subject.
 */

// ─── Main orchestration ─────────────────────────────────────────────────────

export async function generateActionProposal(
  conversation: ConversationThread
): Promise<ActionProposal[]> {
  const summary = conversation.summary_json as unknown as ConversationSummary

  const recentMessages = await getRecentMessages(conversation.id, 10)

  // Find CP from latest message — support both inbound AND outbound
  const latestWithCP = recentMessages
    .filter(m => m.cp_id)
    .pop()

  if (!latestWithCP?.cp_id) return []

  const cp = await getCPById(latestWithCP.cp_id)
  if (!cp || cp.is_blacklisted) return []

  // Detect channel from most recent message
  const lastMessage = recentMessages[recentMessages.length - 1]
  const channelType = await getChannelType(lastMessage?.channel_id)
  const channel: 'email' | 'whatsapp' = channelType === 'whatsapp' ? 'whatsapp' : 'email'

  try {
    // Get user settings for AI context
    const settings = await getUserSettings(conversation.user_id)

    // Build Mila context — journal beliefs
    const milaCtx = await buildMilaContext(
      conversation.id, conversation.user_id, cp.id, summary, 'medium'
    )
    const journalText = formatJournalForPrompt(milaCtx.journal)

    if (journalText) {
      console.log(`[Planning:DEBUG] Journal entries: ${milaCtx.journal.length} (${milaCtx.journal.filter(j => j.type === 'belief').length} beliefs)`)
    }

    // Find latest inbound message
    const latestInboundMsg = [...recentMessages].reverse().find(m => m.direction === 'inbound')
    const latestInboundText = latestInboundMsg
      ? (latestInboundMsg.cleaned_text || latestInboundMsg.raw_text || '')
      : ''

    // Get existing pending actions for this conversation
    const existingPending = await getPendingActionsByType(conversation.id)

    // Format recent messages with age labels
    const now = Date.now()
    const formattedMessages = recentMessages
      .map(m => {
        const text = m.cleaned_text || m.raw_text || ''
        if (!text) return null
        const daysAgo = Math.max(0, Math.round((now - new Date(m.occurred_at || m.timestamp).getTime()) / 86_400_000))
        const age = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`
        return { direction: m.direction || 'inbound', text: text.slice(0, 500), age }
      })
      .filter((m): m is { direction: string; text: string; age: string } => m !== null)

    // Format pending actions for triage prompt
    const pendingForPrompt = Array.from(existingPending.entries())
      .filter(([, v]) => v.id !== '__event__')
      .map(([type, v]) => ({ type, intent: v.intent_cs || '', urgency: v.urgency }))

    // ─── TRIAGE: single-pass decision ───────────────────────────────────
    const triageResult = await triageConversation(
      latestInboundText,
      formattedMessages,
      summary,
      pendingForPrompt,
      cp.name || cp.primary_identifier || 'Unknown',
      channel,
      settings,
      journalText,
    )

    console.log(`[Planning] Triage for ${cp.name || cp.primary_identifier}: needs_action=${triageResult.needs_action}, confidence=${triageResult.confidence}${triageResult.revisit_at ? `, revisit_at=${triageResult.revisit_at}` : ''}`)

    // Outcome 2: No action now, but revisit later → snooze the conversation
    if (!triageResult.needs_action && triageResult.revisit_at) {
      await updateConversation(conversation.id, { snooze_until: triageResult.revisit_at })
      console.log(`[Planning] Conversation snoozed until ${triageResult.revisit_at}: ${triageResult.revisit_reason || 'no reason given'}`)
      return []
    }

    // Outcome 1: No action needed, or confidence too low
    if (!triageResult.needs_action || triageResult.confidence < 0.6) {
      if (triageResult.confidence < 0.6 && triageResult.needs_action) {
        console.log(`[Planning] Triage confidence ${triageResult.confidence} below threshold, discarding`)
      }
      return []
    }

    // ─── VERIFY: cross-check against source message ─────────────────────
    const verifyResult = await verifyTriage(latestInboundText, triageResult, settings)

    // Apply verification corrections
    if (!verifyResult.action_justified) {
      console.log(`[Planning] Verification: action not justified for ${cp.name || cp.primary_identifier}, skipping`)
      return []
    }
    if (!verifyResult.urgency_ok && triageResult.action) {
      console.log(`[Planning] Verification: urgency ${triageResult.action.urgency} → clamped to 2`)
      triageResult.action.urgency = 2
    }
    if (verifyResult.venue_ok === false && triageResult.action) {
      console.log(`[Planning] Verification: venue "${triageResult.action.meeting_venue}" rejected`)
      triageResult.action.meeting_venue = null
      triageResult.action.meeting_venue_source = null
      triageResult.action.meeting_venue_confidence = null
    }

    // ─── Build proposals from triage actions ────────────────────────────
    const triageActions: TriageAction[] = [triageResult.action!]
    if (triageResult.secondary_action) {
      triageActions.push(triageResult.secondary_action)
    }

    // Compute shared scoring inputs
    const latestInbound = await getLatestInboundFromCP(conversation.user_id, cp.id)
    const daysIgnored = computeDaysIgnored(latestInbound?.occurred_at, conversation.created_at)
    const offerMultiplier = selectOfferMultiplier(
      cp.role, settings.offer_multiplier_seller, settings.offer_multiplier_buyer
    )
    const isHighValue = containsHighValueSignals(
      recentMessages.map(m => m.enriched_text || m.cleaned_text || m.raw_text || '').join(' '),
      settings
    )

    // Skip SCHEDULE if conversation already has a future confirmed event (not holds)
    const hasEvent = await hasActiveEventForConversation(conversation.user_id, conversation.id)
    if (hasEvent && !existingPending.has('SCHEDULE')) {
      existingPending.set('SCHEDULE', { id: '__event__', urgency: Infinity, intent_cs: null })
    }

    const createdActions: ActionProposal[] = []
    const seenTypes = new Set<string>()
    const updatedActionIds: string[] = []
    const refreshPairs: { existingId: string; triageAction: TriageAction }[] = []

    for (const ta of triageActions) {
      if (seenTypes.has(ta.type)) continue
      seenTypes.add(ta.type)

      // Dedup against existing pending actions
      const existing = existingPending.get(ta.type)
      if (existing) {
        if (existing.id === '__event__') continue // Confirmed event blocks
        if (ta.urgency > existing.urgency) {
          updatedActionIds.push(existing.id)
        } else {
          refreshPairs.push({ existingId: existing.id, triageAction: ta })
          continue
        }
      }

      // Validate deal_type and write to conversation
      const dealType = validateDealType(ta.deal_type)
      if (dealType) {
        await updateConversation(conversation.id, { deal_type: dealType })
      }

      // SCHEDULE: geocode venue, build scheduling payload
      let schedulingPayload: Record<string, unknown> = {}
      if (ta.type === 'SCHEDULE') {
        const proposedMeetingType = ta.meeting_type || 'address'
        const isRemoteMeeting = proposedMeetingType === 'phone' || proposedMeetingType === 'online'

        let meetingLocation: string | undefined
        if (!isRemoteMeeting) {
          if (ta.meeting_venue) {
            meetingLocation = ta.meeting_venue
          } else if (cp.locations) {
            const locations = cp.locations as unknown
            if (Array.isArray(locations) && locations.length > 0 && typeof locations[0] === 'string') {
              meetingLocation = locations[0]
            } else if (typeof locations === 'string') {
              meetingLocation = locations
            }
          }
        }

        // Geocode
        const tzRegionMap: Record<string, string> = {
          'Europe/Prague': 'cz', 'Europe/Bratislava': 'sk', 'Europe/Berlin': 'de',
          'Europe/Vienna': 'at', 'Europe/Warsaw': 'pl', 'Europe/London': 'gb',
          'Europe/Paris': 'fr', 'Europe/Rome': 'it', 'Europe/Madrid': 'es',
        }
        const geocodeRegion = tzRegionMap[settings.timezone] || undefined
        let locationPartial = false
        if (meetingLocation) {
          const validated = await validateMeetingLocation(meetingLocation, geocodeRegion)
          meetingLocation = validated.location
          locationPartial = validated.needsConfirmation
        }

        // Low confidence → flag for user
        if (ta.meeting_venue_confidence === 'low' && meetingLocation) {
          locationPartial = true
        }

        // Missing address for in-person meeting
        if (!isRemoteMeeting && !meetingLocation) {
          const hasAddressField = ta.missing_info?.some(f => f.label.toLowerCase().includes('adresa'))
          if (!hasAddressField) {
            ta.missing_info = [
              ...(ta.missing_info || []),
              { label: 'Kde se schůzka koná? (adresa nebo Online)', value: null },
            ]
          }
        }

        schedulingPayload = {
          suggestedTime: ta.proposed_time || null,
          suggestedLocation: meetingLocation || null,
          location_partial: locationPartial,
          cp_availability: null,
          duration: settings.default_meeting_duration,
          meeting_type: proposedMeetingType,
          is_online: proposedMeetingType === 'online',
          cp_phone: ta.cp_phone || null,
        }
      }

      const weight = ta.immovable ? 100 : (ta.weight || 0)
      const priorityScore = calculatePriorityScore({
        dollarValue: ta.dollar_value,
        urgency: ta.urgency,
        daysIgnored,
        sellerMultiplier: offerMultiplier,
        kcHighValue: settings.kc_high_value,
        weight,
      })

      // Supersede lower-urgency pending action
      const superseded = existingPending.get(ta.type)
      if (superseded && updatedActionIds.includes(superseded.id)) {
        await dismissAction(superseded.id, conversation.user_id)
        console.log(`[Planning] Superseded ${ta.type} (urgency ${superseded.urgency} → ${ta.urgency}) for ${cp.name || cp.primary_identifier}`)
      }

      if (ta.urgency >= 9) {
        console.log(`[Planning] URGENT action created: urgency=${ta.urgency}, type=${ta.type}, cp=${cp.name || cp.primary_identifier}`)
      }

      const action = await createAction({
        id: uuidv4(),
        user_id: conversation.user_id,
        conversation_id: conversation.id,
        cp_id: cp.id,
        action_type: ta.type,
        intent_cs: ta.intent_cs,
        rationale_cs: ta.rationale_cs,
        missing_info: ta.missing_info,
        rationale: ta.rationale_cs,
        priority_score: priorityScore,
        dollar_value: ta.dollar_value,
        offer_multiplier: offerMultiplier,
        urgency: ta.urgency,
        weight,
        draft_subject: null,
        draft_body_text: null,
        payload: {
          intent_cs: ta.intent_cs,
          execution_plan: ta.rationale_cs,
          required_inputs: ta.missing_info,
          channel,
          action_metadata: {
            action_type: ta.type,
            urgency: ta.urgency,
            dollar_value: ta.dollar_value,
            offer_multiplier: offerMultiplier,
            weight,
            deal_type: dealType,
            is_high_value: isHighValue || ta.dollar_value > settings.kc_high_value,
          },
          ...schedulingPayload,
        },
        queued_for_brief: true,
      })

      createdActions.push(action)
    }

    // Refresh existing actions whose conversations got new messages
    for (const { existingId, triageAction: ta } of refreshPairs) {
      try {
        await updateAction(existingId, {
          intent_cs: ta.intent_cs,
          rationale_cs: ta.rationale_cs,
          urgency: ta.urgency,
          priority_score: calculatePriorityScore({
            dollarValue: ta.dollar_value,
            urgency: ta.urgency,
            daysIgnored,
            sellerMultiplier: offerMultiplier,
            kcHighValue: settings.kc_high_value,
            weight: ta.immovable ? 100 : (ta.weight || 0),
          }),
          dollar_value: ta.dollar_value,
          updated_at: new Date().toISOString(),
        })
        console.log(`[Planning] Refreshed ${ta.type} for ${cp.name || cp.primary_identifier} — new intent from latest messages`)
      } catch (err) {
        console.error(`[Planning] Failed to refresh action ${existingId}:`, err)
      }
    }

    return createdActions
  } catch (error) {
    console.error('Failed to generate action proposal:', error)
    return []
  }
}

/**
 * Process conversations in parallel with controlled concurrency.
 * Each conversation involves AI calls so we batch to avoid overwhelming
 * the rate limit while still being much faster than serial processing.
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

  // Build full context for the draft — timeline + journal give Mila conversation-level awareness
  const draftCtx = await buildMilaContext(
    conversation.id, action.user_id, action.cp_id,
    conversation.summary_json as ConversationSummary | null,
    'full'
  )

  const recentMsgs = await getRecentMessages(conversation.id, 5)
  const recentMsgTexts = recentMsgs
    .map(m => ({ direction: m.direction || 'inbound', text: m.cleaned_text || m.raw_text || '' }))
    .filter(m => m.text.length > 0)

  return generateFinalDraft(
    conversation.summary_json,
    userIntent || action.intent_cs || action.rationale_cs || action.rationale,
    settings,
    undefined,
    (action.missing_info as { label: string; value: string | null }[] | null) || undefined,
    cp?.name || cp?.primary_identifier || undefined,
    channel,
    formatTimelineForPrompt(draftCtx.timeline),
    formatJournalForPrompt(draftCtx.journal) || undefined,
    recentMsgTexts
  )
}
