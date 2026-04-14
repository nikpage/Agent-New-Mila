import { triageConversation, verifyTriage, parseEnrichedText, extractMessageFacts, type TriageAction, type TriageResult, type EnrichedMessageData } from '@/lib/ai/tasks'
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
import { getLatestInboundFromCP } from '@/lib/db/timeline'
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
 * Map urgency category + enrichment urgency signal to a 1-10 number.
 * The AI picks a coarse category (5 levels). Code maps to the specific number
 * using the enrichment's urgency classification as a fine-grained selector.
 */
function mapUrgencyToNumber(
  category: 'CRITICAL' | 'TODAY' | 'THIS_WEEK' | 'SOON' | 'NONE',
  enrichmentSignal: 'HARD DEADLINE' | 'SOFT REFERENCE' | null
): number {
  // Base mapping from AI's urgency category
  const baseMap: Record<string, number> = {
    CRITICAL: 9, TODAY: 7, THIS_WEEK: 5, SOON: 3, NONE: 1,
  }
  const base = baseMap[category] || 1

  // Enrichment adjusts: hard deadline bumps up, soft reference bumps +1
  if (enrichmentSignal === 'HARD DEADLINE') {
    return Math.min(10, Math.max(base, 9))  // at least 9, cap at 10
  }
  if (enrichmentSignal === 'SOFT REFERENCE') {
    return Math.min(10, base + 1)  // gentle bump, e.g. THIS_WEEK 5 -> 6
  }
  return base
}

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

    // Parse enrichment data from latest inbound message
    const enrichment: EnrichedMessageData | null = latestInboundMsg?.enriched_text
      ? parseEnrichedText(latestInboundMsg.enriched_text)
      : null

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

    // ─── EXTRACT: dedicated reading comprehension (triage_extract stage) ───
    // Runs at temp 0 — more reliable for structured venue/time/questions fields.
    // Only runs when enrichment is available (needs the addresses/times reference lists).
    const cpName = cp.name || cp.primary_identifier || 'Unknown'
    const extraction = enrichment ? await extractMessageFacts(
      latestInboundText,
      enrichment,
      summary,
      cpName,
      settings,
    ) : null

    // ─── TRIAGE: single-pass decision ───────────────────────────────────
    const triageResult = await triageConversation(
      latestInboundText,
      formattedMessages,
      summary,
      pendingForPrompt,
      cpName,
      channel,
      settings,
      journalText,
      enrichment,
    )

    // ─── DETERMINISTIC SCHEDULE: code creates from enrichment data, not AI ─
    const triageActions: TriageAction[] = triageResult.action ? [triageResult.action] : []

    // ─── EXTRACTION MERGE: override triage AI's venue/time with dedicated extraction ─
    // extractMessageFacts runs at temp 0 — more reliable for structured fields.
    // Runs before code gates so the validated values flow through normally.
    if (extraction && triageResult.action) {
      if (extraction.confirmed_venue_index !== null) {
        triageResult.action.venue_index = extraction.confirmed_venue_index
        triageResult.action.meeting_venue = null // index takes priority
      } else if (extraction.confirmed_venue_freetext) {
        triageResult.action.meeting_venue = extraction.confirmed_venue_freetext
        triageResult.action.venue_index = null
      }
      if (extraction.confirmed_time_index !== null) {
        triageResult.action.time_index = extraction.confirmed_time_index
        triageResult.action.proposed_time = null
      } else if (extraction.confirmed_time_freetext) {
        triageResult.action.proposed_time = extraction.confirmed_time_freetext
        triageResult.action.time_index = null
      }
      // Merge CP questions into missing_info if triage didn't capture them
      if (extraction.questions_for_user.length > 0 && triageResult.action.missing_info.length === 0) {
        triageResult.action.missing_info = extraction.questions_for_user.map(q => ({ label: q, value: null }))
      }
      // what_cp_said is extraction's summary of CP intent — use as what_cp_wants fallback
      if (!triageResult.action.what_cp_wants && extraction.what_cp_said) {
        triageResult.action.what_cp_wants = extraction.what_cp_said
      }
    }

    if (
      triageResult.action &&
      triageResult.action.type !== 'SCHEDULE' &&
      (triageResult.action.time_index !== null || triageResult.action.venue_index !== null ||
       triageResult.action.proposed_time !== null || triageResult.action.meeting_venue !== null)
    ) {
      console.log(`[Planning] Deterministic SCHEDULE: time_index=${triageResult.action.time_index}, venue_index=${triageResult.action.venue_index}, proposed_time=${triageResult.action.proposed_time}`)
      triageActions.push({
        type: 'SCHEDULE',
        intent_cs: 'Naplánovat schůzku dle požadavku.',
        rationale_cs: 'Protistrana navrhla čas nebo místo.',
        urgency_category: triageResult.action.urgency_category,
        urgency_justification: 'Odvozeno z triage.',
        what_cp_wants: triageResult.action.what_cp_wants,
        venue_index: triageResult.action.venue_index,
        meeting_venue: triageResult.action.meeting_venue,
        time_index: triageResult.action.time_index,
        proposed_time: triageResult.action.proposed_time,
        deal_type: triageResult.action.deal_type,
        weight: 7,
        immovable: false,
        missing_info: [],
      })
    }

    console.log(`[Planning] Triage for ${cpName}: needs_action=${triageResult.needs_action}, confidence=${triageResult.confidence}${triageResult.revisit_at ? `, revisit_at=${triageResult.revisit_at}` : ''}`)

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

    // ─── CODE GATES: validate triage output against enrichment ──────────
    if (triageResult.action) {
      const ta = triageResult.action

      // Gate 1: Resolve venue_index → validate against enrichment addresses
      if (ta.venue_index !== null && enrichment?.addresses?.length) {
        if (ta.venue_index < 0 || ta.venue_index >= enrichment.addresses.length) {
          console.log(`[Planning] venue_index ${ta.venue_index} out of range (${enrichment.addresses.length} addresses), setting null`)
          ta.venue_index = null
        }
      } else if (ta.venue_index !== null) {
        ta.venue_index = null
      }

      // Gate 2: Resolve time_index → validate against enrichment times
      if (ta.time_index !== null && enrichment?.proposedTimes?.length) {
        if (ta.time_index < 0 || ta.time_index >= enrichment.proposedTimes.length) {
          console.log(`[Planning] time_index ${ta.time_index} out of range (${enrichment.proposedTimes.length} times), setting null`)
          ta.time_index = null
        }
      } else if (ta.time_index !== null) {
        ta.time_index = null
      }

      // Gate 3: intent_cs word count check
      if (ta.type === 'REPLY' || ta.type === 'SCHEDULE') {
        const wordCount = ta.intent_cs.split(/\s+/).length
        if (wordCount > 25) {
          ta.intent_cs = ta.intent_cs.split(/\s+/).slice(0, 20).join(' ')
          console.log(`[Planning] intent_cs truncated from ${wordCount} to 20 words`)
        }
      }
    }

    // ─── VERIFY: only check action justification (slim AI call) ─────────
    const verifyResult = await verifyTriage(latestInboundText, triageResult, settings)

    if (!verifyResult.action_justified) {
      console.log(`[Planning] Verification: action not justified for ${cp.name || cp.primary_identifier}, skipping`)
      return []
    }

    // ─── Resolve enrichment values for action creation ──────────────────
    // Parse dollar_value from enrichment
    let enrichmentDollarValue = 0
    if (enrichment?.keyNumbers?.price) {
      const priceStr = enrichment.keyNumbers.price.replace(/[^\d.,]/g, '').replace(',', '.')
      const parsed = parseFloat(priceStr)
      if (!isNaN(parsed) && parsed >= 0) {
        enrichmentDollarValue = parsed
        if (enrichmentDollarValue > settings.typical_deal_size_max * 10) {
          console.log(`[Planning] dollar_value ${enrichmentDollarValue} exceeds 10x max, capping`)
          enrichmentDollarValue = settings.typical_deal_size_max * 10
        }
      }
    }

    const enrichmentSignal = (enrichment?.urgency?.classification as 'HARD DEADLINE' | 'SOFT REFERENCE') || null
    const enrichmentMeetingType = enrichment?.meetingType || null

    // Build cp_availability string from enrichment proposedTimes
    // The scheduler's filterSlotsByCpAvailability parses day names, morning/afternoon, and "at HH:MM"
    let cpAvailabilityText: string | null = null
    if (enrichment?.proposedTimes?.length) {
      const parts: string[] = []
      for (const t of enrichment.proposedTimes) {
        const pieces: string[] = []
        if (t.dayOfWeek) pieces.push(t.dayOfWeek)
        else if (t.relativeRef === 'tomorrow') {
          const d = new Date(); d.setDate(d.getDate() + 1)
          const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
          pieces.push(dayNames[d.getDay()])
        } else if (t.relativeRef === 'today') {
          const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
          pieces.push(dayNames[new Date().getDay()])
        }
        if (t.timeOfDay) {
          pieces.push(`at ${t.timeOfDay}`)
        } else if (t.original) {
          // Pass the original text so the scheduler can parse times from it
          // e.g. "kolem 9 nebo 10" → scheduler extracts 9 and 10
          pieces.push(t.original)
        }
        if (pieces.length > 0) parts.push(pieces.join(' '))
      }
      if (parts.length > 0) {
        cpAvailabilityText = parts.join(' or ')
      }
    }

    // ─── Build proposals from triage actions (triageActions built above) ─

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
    const refreshPairs: { existingId: string; existingUrgency: number; triageAction: TriageAction }[] = []

    for (const ta of triageActions) {
      if (seenTypes.has(ta.type)) continue
      seenTypes.add(ta.type)

      // Resolve values from enrichment + triage
      const resolvedUrgency = mapUrgencyToNumber(ta.urgency_category, enrichmentSignal)
      const resolvedMeetingVenue = (ta.venue_index !== null && enrichment?.addresses
        ? enrichment.addresses[ta.venue_index] : null) ?? ta.meeting_venue
      const resolvedProposedTime = ta.time_index !== null && enrichment?.proposedTimes
        ? enrichment.proposedTimes[ta.time_index] : null
      const resolvedMeetingType = enrichmentMeetingType

      // Dedup against existing pending actions
      const existing = existingPending.get(ta.type)
      if (existing) {
        if (existing.id === '__event__') continue // Confirmed event blocks
        if (resolvedUrgency > existing.urgency) {
          updatedActionIds.push(existing.id)
        } else {
          refreshPairs.push({ existingId: existing.id, existingUrgency: existing.urgency, triageAction: ta })
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
        const proposedMeetingTypeStr = resolvedMeetingType || 'address'
        // Detect remote meetings from enrichment meeting type
        const isRemoteMeeting = proposedMeetingTypeStr === 'phone' || proposedMeetingTypeStr === 'online'
          || /online|video|phone|call|teams|zoom|hovor/i.test(proposedMeetingTypeStr)

        // Always try to find an address — even for phone/online meetings
        // the user may change meeting type and need it
        let meetingLocation: string | undefined
        if (resolvedMeetingVenue) {
          meetingLocation = resolvedMeetingVenue
        } else if (cp.locations) {
          const locations = cp.locations as unknown
          if (Array.isArray(locations) && locations.length > 0 && typeof locations[0] === 'string') {
            meetingLocation = locations[0]
          } else if (typeof locations === 'string') {
            meetingLocation = locations
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

        // Resolve proposed time to ISO string
        let suggestedTime: string | null = null
        if (resolvedProposedTime) {
          let date = resolvedProposedTime.specificDate || null
          const time = resolvedProposedTime.timeOfDay || null

          // Resolve relative date references when specificDate is missing
          if (!date && resolvedProposedTime.relativeRef) {
            const today = new Date()
            const ref = resolvedProposedTime.relativeRef.toLowerCase()
            if (ref === 'today') {
              date = today.toISOString().slice(0, 10)
            } else if (ref === 'tomorrow') {
              const d = new Date(today); d.setDate(d.getDate() + 1)
              date = d.toISOString().slice(0, 10)
            } else if (ref === 'day_after_tomorrow') {
              const d = new Date(today); d.setDate(d.getDate() + 2)
              date = d.toISOString().slice(0, 10)
            } else if (ref === 'next_week') {
              const d = new Date(today); d.setDate(d.getDate() + (8 - d.getDay()) % 7 || 7)
              date = d.toISOString().slice(0, 10)
            }
          }

          // Resolve dayOfWeek when no date yet
          if (!date && resolvedProposedTime.dayOfWeek) {
            const dayMap: Record<string, number> = {
              sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
              thursday: 4, friday: 5, saturday: 6,
            }
            const target = dayMap[resolvedProposedTime.dayOfWeek.toLowerCase()]
            if (target !== undefined) {
              const today = new Date()
              let diff = target - today.getDay()
              if (diff <= 0) diff += 7
              const d = new Date(today); d.setDate(d.getDate() + diff)
              date = d.toISOString().slice(0, 10)
            }
          }

          if (date && time) {
            suggestedTime = `${date}T${time}:00`
          } else if (date) {
            suggestedTime = `${date}T10:00:00`
          }
        }

        // Fallback: triage resolved the time directly (relative dates, implied times)
        if (!suggestedTime && ta.proposed_time) {
          const parsed = new Date(ta.proposed_time)
          if (!isNaN(parsed.getTime())) {
            suggestedTime = ta.proposed_time
          }
        }

        const meetingTypeForPayload = isRemoteMeeting
          ? (/online|video|teams|zoom/i.test(proposedMeetingTypeStr) ? 'online' : 'phone')
          : 'address'

        schedulingPayload = {
          suggestedTime,
          suggestedLocation: meetingLocation || null,
          location_partial: locationPartial,
          cp_availability: cpAvailabilityText,
          duration: settings.default_meeting_duration,
          meeting_type: meetingTypeForPayload,
          is_online: meetingTypeForPayload === 'online',
          cp_phone: null,
        }
      }

      const weight = ta.immovable ? 100 : (ta.weight || 0)
      const priorityScore = calculatePriorityScore({
        dollarValue: enrichmentDollarValue,
        urgency: resolvedUrgency,
        daysIgnored,
        sellerMultiplier: offerMultiplier,
        kcHighValue: settings.kc_high_value,
        weight,
      })

      // Supersede lower-urgency pending action
      const superseded = existingPending.get(ta.type)
      if (superseded && updatedActionIds.includes(superseded.id)) {
        await dismissAction(superseded.id, conversation.user_id)
        console.log(`[Planning] Superseded ${ta.type} (urgency ${superseded.urgency} → ${resolvedUrgency}) for ${cp.name || cp.primary_identifier}`)
      }

      if (resolvedUrgency >= 9) {
        console.log(`[Planning] URGENT action created: urgency=${resolvedUrgency}, type=${ta.type}, cp=${cp.name || cp.primary_identifier}`)
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
        dollar_value: enrichmentDollarValue,
        offer_multiplier: offerMultiplier,
        urgency: resolvedUrgency,
        weight,
        draft_subject: null,
        draft_body_text: null,
        payload: {
          intent_cs: ta.intent_cs,
          execution_plan: ta.rationale_cs,
          what_cp_wants: ta.what_cp_wants || null,
          urgency_justification: ta.urgency_justification || null,
          required_inputs: ta.missing_info,
          channel,
          action_metadata: {
            action_type: ta.type,
            urgency: resolvedUrgency,
            dollar_value: enrichmentDollarValue,
            offer_multiplier: offerMultiplier,
            weight,
            deal_type: dealType,
            is_high_value: isHighValue || enrichmentDollarValue > settings.kc_high_value,
          },
          ...schedulingPayload,
        },
        queued_for_brief: true,
      })

      createdActions.push(action)
    }

    // Refresh existing actions whose conversations got new messages.
    // Use Math.max to escalate urgency — never lower an existing action's urgency.
    for (const { existingId, existingUrgency, triageAction: ta } of refreshPairs) {
      try {
        const resolvedUrgency = mapUrgencyToNumber(ta.urgency_category, enrichmentSignal)
        const escalatedUrgency = Math.max(existingUrgency, resolvedUrgency)
        await updateAction(existingId, {
          intent_cs: ta.intent_cs,
          rationale_cs: ta.rationale_cs,
          urgency: escalatedUrgency,
          priority_score: calculatePriorityScore({
            dollarValue: enrichmentDollarValue,
            urgency: escalatedUrgency,
            daysIgnored,
            sellerMultiplier: offerMultiplier,
            kcHighValue: settings.kc_high_value,
            weight: ta.immovable ? 100 : (ta.weight || 0),
          }),
          dollar_value: enrichmentDollarValue,
          updated_at: new Date().toISOString(),
        })
        console.log(`[Planning] Refreshed ${ta.type} for ${cp.name || cp.primary_identifier} — urgency ${existingUrgency}→${escalatedUrgency}`)
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
