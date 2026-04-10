import { decideActionType, generateIntent, extractCPRequest, type ProposedAction, type EnrichedMessageData } from '@/lib/ai/gemini'
import { generateFinalDraft } from '@/lib/ai/mila-voice'
import { buildMilaContext, formatTimelineForPrompt, formatJournalForPrompt, formatEnrichedForPrompt } from '@/lib/ai/context'
import {
  createAction,
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
import { isWorkingDay, getNextWorkingDay } from '@/lib/holidays'
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

// ─── Deterministic functions (no AI) ────────────────────────────────────────

/**
 * Compute urgency from enrichment data — no AI, pure date math.
 *
 * ADDRESS INFERENCE for SCHEDULE actions uses selectMeetingLocation below.
 * suggestedLocation is the MEETING VENUE — WHERE PEOPLE WILL MEET,
 * NOT the property or deal subject unless the meeting is literally at the property.
 * Priority: (1) explicit venue stated in conversation, (2) CP's office from
 * signature if meeting is at their place, (3) user's office if CP says
 * "at your office", (4) property address ONLY if the meeting is literally at the property (e.g. a viewing/inspection).
 * Addresses in email signatures are the SENDER's company address — do not
 * confuse with meeting venue. A conversation about "office space in Karlin"
 * does NOT mean the meeting is in Karlin.
 * ADDRESS INFERENCE for SCHEDULE: selectMeetingLocation reads from enrichment's
 * addresses[] — the MEETING VENUE, not the property subject.
 */
export function computeUrgencyFromEnrichment(
  enriched: EnrichedMessageData | null,
  today: Date,
  settings?: UserSettings | null,
  cpRole?: string | null,
  journalBeliefs?: string
): { deadlineUrgency: number; meetingPrepUrgency: number } {
  let deadlineUrgency = 2 // default: no deadline language
  let meetingPrepUrgency = 2 // default: no meeting

  if (enriched?.urgency) {
    const quote = (enriched.urgency.quote || '').toLowerCase()
    if (enriched.urgency.classification === 'HARD DEADLINE') {
      if (/\b(dnes|today|do \d{1,2}[:.]\d{2})\b/.test(quote)) {
        deadlineUrgency = 10
      } else if (/\b(zítra|tomorrow)\b/.test(quote)) {
        deadlineUrgency = 9
      } else if (/\b(pondělí|úterý|střed[auy]|čtvrtek|pátek|sobota|neděle|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(quote)) {
        deadlineUrgency = 8
      } else if (/\b(tento týden|this week)\b/i.test(quote)) {
        deadlineUrgency = 7
      } else if (/\b(jinak|propadá|otherwise|expire|forfeit)\b/i.test(quote)) {
        deadlineUrgency = 7
      } else {
        deadlineUrgency = 7 // HARD DEADLINE, no recognizable pattern → assume this week
      }
    } else if (enriched.urgency.classification === 'SOFT REFERENCE') {
      if (/\b(žádný spěch|no rush|není kam spěchat)\b/i.test(quote)) {
        deadlineUrgency = 1
      } else {
        deadlineUrgency = 5
      }
    }
  }

  if (enriched?.proposedTimes?.[0] && settings) {
    const resolved = resolveProposedDate(enriched.proposedTimes[0], today, settings, cpRole, journalBeliefs)
    if (resolved) {
      const daysUntil = Math.max(0, Math.floor((resolved.date.getTime() - today.getTime()) / 86_400_000))
      if (daysUntil === 0) meetingPrepUrgency = 10
      else if (daysUntil === 1) meetingPrepUrgency = 9
      else if (daysUntil <= 3) meetingPrepUrgency = 8
      else if (daysUntil <= 5) meetingPrepUrgency = 7
      else meetingPrepUrgency = 5
    }
  }

  return { deadlineUrgency, meetingPrepUrgency }
}

/**
 * Select meeting location from enrichment data — no AI, no hallucination.
 * Reads directly from enrichment's addresses[].
 */
export function selectMeetingLocation(
  enriched: EnrichedMessageData | null
): { location: string | null; confidence: 'high' | 'low' | null } {
  if (!enriched) return { location: null, confidence: null }

  const mt = (enriched.meetingType || '').toLowerCase()
  if (/\b(phone|call|telefon|zavolat|hovor)\b/i.test(mt)) return { location: null, confidence: null }
  if (/\b(online|video|meet|zoom|teams)\b/i.test(mt)) return { location: null, confidence: null }

  if (!enriched.addresses?.length) return { location: null, confidence: null }

  // Strip "Adresa:" prefix if enrichment leaked it into JSON values
  const cleaned = enriched.addresses.map(a => a.replace(/^Adresa:\s*/i, '').trim()).filter(Boolean)
  if (!cleaned.length) return { location: null, confidence: null }

  // Prefer addresses with a street number over bare names
  const withNumber = cleaned.filter(a => /\d/.test(a))
  if (withNumber.length === 1) return { location: withNumber[0], confidence: 'high' }
  if (withNumber.length > 1) return { location: withNumber[0], confidence: 'low' }

  if (cleaned.length === 1) return { location: cleaned[0], confidence: 'high' }
  return { location: cleaned[0], confidence: 'low' }
}

// ─── Date resolution (no AI) ──────────────────────────────────────────────

export interface ResolvedDate {
  /** Start of the resolved day (00:00 in user's TZ) */
  date: Date
  /** Specific time if stated, null = "during business hours" */
  time: string | null
  /** How confident: 'exact' (specific date+time), 'day' (right day, no time), 'inferred' (business vs calendar day logic applied) */
  confidence: 'exact' | 'day' | 'inferred'
}

/**
 * Resolve a relative date reference to an actual calendar date.
 *
 * Resolution priority:
 * 1. Journal beliefs about this CP (e.g. "always does Saturday viewings")
 * 2. CP role (lawyer/notary → business days)
 * 3. Event context from enrichment (viewing → calendar days, legal → business days)
 * 4. Default: business days per user working_days setting
 */
export function resolveProposedDate(
  proposed: NonNullable<EnrichedMessageData['proposedTimes']>[0],
  today: Date,
  settings: UserSettings,
  cpRole?: string | null,
  journalBeliefs?: string
): ResolvedDate | null {

  const workingDays = settings.working_days || [1, 2, 3, 4, 5]

  // --- Explicit calendar date: trust it directly ---
  if (proposed.relativeRef === 'specific_date' && proposed.specificDate) {
    const d = new Date(proposed.specificDate + 'T00:00:00')
    return { date: d, time: proposed.timeOfDay || null, confidence: proposed.timeOfDay ? 'exact' : 'day' }
  }

  // --- Named day of week: find the next occurrence (or today if it matches) ---
  if (proposed.relativeRef === 'specific_day' && proposed.dayOfWeek) {
    const targetDay = dayOfWeekToISO(proposed.dayOfWeek)
    if (targetDay !== null) {
      const d = nextOccurrenceOfDay(today, targetDay)
      return { date: d, time: proposed.timeOfDay || null, confidence: proposed.timeOfDay ? 'exact' : 'day' }
    }
  }

  // --- Relative references: "tomorrow", "today", etc ---
  const useBusinessDays = shouldUseBusinessDays(proposed.eventContext, cpRole, journalBeliefs)

  if (proposed.relativeRef === 'today') {
    return { date: today, time: proposed.timeOfDay || null, confidence: proposed.timeOfDay ? 'exact' : 'day' }
  }

  if (proposed.relativeRef === 'tomorrow') {
    const calendarTomorrow = addDays(today, 1)
    if (useBusinessDays && !isWorkingDay(calendarTomorrow, workingDays)) {
      return { date: getNextWorkingDay(today, workingDays), time: proposed.timeOfDay || null, confidence: 'inferred' }
    }
    return { date: calendarTomorrow, time: proposed.timeOfDay || null, confidence: proposed.timeOfDay ? 'exact' : 'day' }
  }

  if (proposed.relativeRef === 'day_after_tomorrow') {
    const calendarDAT = addDays(today, 2)
    if (useBusinessDays && !isWorkingDay(calendarDAT, workingDays)) {
      return { date: getNextWorkingDay(addDays(today, 1), workingDays), time: proposed.timeOfDay || null, confidence: 'inferred' }
    }
    return { date: calendarDAT, time: proposed.timeOfDay || null, confidence: proposed.timeOfDay ? 'exact' : 'day' }
  }

  if (proposed.relativeRef === 'this_week') {
    const nextWork = isWorkingDay(today, workingDays) ? today : getNextWorkingDay(today, workingDays)
    return { date: nextWork, time: proposed.timeOfDay || null, confidence: 'inferred' }
  }

  if (proposed.relativeRef === 'next_week') {
    const nextMonday = nextOccurrenceOfDay(today, 1)
    const nextWork = isWorkingDay(nextMonday, workingDays) ? nextMonday : getNextWorkingDay(nextMonday, workingDays)
    return { date: nextWork, time: proposed.timeOfDay || null, confidence: 'inferred' }
  }

  return null
}

/**
 * Determine whether a "tomorrow"-type reference should snap to business days.
 *
 * Calendar days (weekends valid): viewings, showings, delivery
 * Business days (skip weekends): legal, notary, signing, office meetings, deadlines
 *
 * Journal beliefs override everything — if Mila has learned this CP does
 * Saturday viewings or never works Fridays, that knowledge wins.
 */
export function shouldUseBusinessDays(
  eventContext?: string | null,
  cpRole?: string | null,
  journalBeliefs?: string
): boolean {
  // --- Journal beliefs override (highest priority) ---
  if (journalBeliefs) {
    const weekendMatch = journalBeliefs.search(/(?:\b(?:weekends?|saturdays?|sundays?)\b|(?:sobota|soboty|neděle|víkend[uy]?)(?=\s|$|[,.:;]))/i)
    if (weekendMatch >= 0) {
      const windowStart = Math.max(0, weekendMatch - 30)
      const windowEnd = weekendMatch + 50
      const window = journalBeliefs.slice(windowStart, windowEnd)
      const weekendNegated = /(?:\b(?:never|not|no)\b|ne[- ]|nikdy)/i.test(window)
      if (weekendNegated) return true   // CP avoids weekends → business days
      return false                       // CP does weekends → calendar days
    }

    if (/(?:only weekdays|jen pracovní)/i.test(journalBeliefs)) {
      return true
    }
  }

  // --- CP role (second priority) ---
  if (cpRole && ['lawyer', 'notary', 'appraiser', 'inspector'].includes(cpRole)) {
    return true
  }

  // --- Event context (third priority) ---
  const calendarDayContexts = ['viewing', 'showing', 'delivery']
  const businessDayContexts = ['signing', 'notary', 'legal', 'office_meeting', 'deadline']

  if (eventContext && calendarDayContexts.includes(eventContext)) return false
  if (eventContext && businessDayContexts.includes(eventContext)) return true

  // --- Default: business days ---
  return true
}

function dayOfWeekToISO(day: string): number | null {
  const map: Record<string, number> = {
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
    friday: 5, saturday: 6, sunday: 7
  }
  return map[day.toLowerCase()] ?? null
}

function nextOccurrenceOfDay(from: Date, targetISODay: number): Date {
  const d = new Date(from)
  const currentISO = d.getDay() === 0 ? 7 : d.getDay()
  let daysAhead = targetISODay - currentISO
  if (daysAhead < 0) daysAhead += 7  // next occurrence; 0 = today (same day allowed)
  d.setDate(d.getDate() + daysAhead)
  return d
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/**
 * Extract suggested meeting time from enrichment data — no AI.
 * Uses resolveProposedDate for context-aware date resolution.
 */
export function extractSuggestedTime(
  enriched: EnrichedMessageData | null,
  settings: UserSettings,
  cpRole?: string | null,
  journalBeliefs?: string
): string | null {
  if (!enriched?.proposedTimes?.[0]) return null
  const resolved = resolveProposedDate(enriched.proposedTimes[0], new Date(), settings, cpRole, journalBeliefs)
  if (!resolved) return null

  if (resolved.time) {
    const [hh, mm] = resolved.time.split(':')
    const d = new Date(resolved.date)
    d.setHours(parseInt(hh, 10), parseInt(mm, 10), 0, 0)
    return d.toISOString()
  }
  return resolved.date.toISOString()
}

// ─── Main orchestration ─────────────────────────────────────────────────────

export async function generateActionProposal(
  conversation: ConversationThread
): Promise<ActionProposal[]> {
  const summary = conversation.summary_json as unknown as ConversationSummary

  const recentMessages = await getRecentMessages(conversation.id, 10)
  const timelineEntries = await getTimelineForConversation(conversation.id, 10)

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

    // Build Mila's full context — journal beliefs + enriched fields from latest inbound
    const milaCtx = await buildMilaContext(
      conversation.id, conversation.user_id, cp.id, summary, 'full'
    )
    const journalText = formatJournalForPrompt(milaCtx.journal)
    const enrichedText = formatEnrichedForPrompt(milaCtx.enriched)

    if (journalText) {
      console.log(`[Planning:DEBUG] Journal entries: ${milaCtx.journal.length} (${milaCtx.journal.filter(j => j.type === 'belief').length} beliefs)`)
    }

    // Step 3: Pre-extract CP's current request from the latest inbound message.
    const latestInboundMsg = [...recentMessages].reverse().find(m => m.direction === 'inbound')
    let cpRequest = ''
    if (latestInboundMsg) {
      const inboundText = latestInboundMsg.cleaned_text || latestInboundMsg.raw_text || ''
      if (inboundText.length > 20) {
        try {
          cpRequest = await extractCPRequest(inboundText, cp.name, settings)
          console.log(`[Planning] CP request extracted: ${cpRequest.slice(0, 150)}`)
        } catch (e) {
          console.warn('[Planning] CP request extraction failed, continuing without:', e)
        }
      }
    }

    // Step 4: Decide action types (narrow AI call — classification only)
    const decisions = await decideActionType(cpRequest, enrichedText, summary, cp.name, settings)

    // Step 5: SCHEDULE absorbs REPLY safety net
    const hasScheduleDecision = decisions.some(d => d.actionType === 'SCHEDULE')
    const filteredDecisions = hasScheduleDecision
      ? decisions.filter(d => d.actionType !== 'REPLY')
      : decisions

    if (hasScheduleDecision && filteredDecisions.length < decisions.length) {
      console.log(`[Planning] Filtered REPLY — SCHEDULE absorbs it`)
    }

    // Step 6: Compute urgency from enrichment (deterministic, no AI)
    const { deadlineUrgency, meetingPrepUrgency } = computeUrgencyFromEnrichment(milaCtx.enriched, new Date(), settings, cp.role, journalText)

    // Step 7: For each decision, generate intent + assemble ProposedAction
    const proposals: ProposedAction[] = []
    for (const decision of filteredDecisions) {
      // 7a: Compute urgency based on action type
      let urgency: number
      if (decision.actionType === 'SCHEDULE') {
        urgency = Math.max(deadlineUrgency, meetingPrepUrgency)
      } else if (decision.actionType === 'TODO' && hasScheduleDecision) {
        urgency = Math.max(meetingPrepUrgency, deadlineUrgency - 1)
      } else if (decision.actionType === 'REPLY') {
        urgency = deadlineUrgency
      } else {
        // TODO standalone
        urgency = deadlineUrgency
      }

      // 7b/7c: Location and time for SCHEDULE (deterministic, no AI)
      let suggestedLocation: string | null = null
      let locationConfidence: 'high' | 'low' | null = null
      let suggestedTime: string | null = null
      if (decision.actionType === 'SCHEDULE') {
        const loc = selectMeetingLocation(milaCtx.enriched)
        suggestedLocation = loc.location
        locationConfidence = loc.confidence
        suggestedTime = extractSuggestedTime(milaCtx.enriched, settings, cp.role, journalText)
      }

      // 7d: Generate intent (AI call — content generation)
      const intent = await generateIntent(decision, cpRequest, enrichedText, summary, cp.name, settings, channel, journalText)

      // 7e: Assemble ProposedAction
      proposals.push({
        actionType: decision.actionType,
        rationale_cs: decision.rationale_cs,
        intent_cs: intent.intent_cs,
        missingInfo: intent.missingInfo,
        urgency,
        dollarValue: intent.dollarValue,
        weight: intent.weight,
        immovable: intent.immovable,
        dealType: intent.dealType,
        suggestedLocation,
        locationConfidence,
        suggestedTime,
        meetingType: intent.meetingType,
        cpPhone: intent.cpPhone,
      })
    }

    // Step 8: Dedup with existing pending actions
    const latestInbound = await getLatestInboundFromCP(conversation.user_id, cp.id)
    const daysIgnored = computeDaysIgnored(latestInbound?.occurred_at, conversation.created_at)
    const offerMultiplier = selectOfferMultiplier(
      cp.role, settings.offer_multiplier_seller, settings.offer_multiplier_buyer
    )
    const isHighValue = containsHighValueSignals(
      recentMessages.map(m => m.enriched_text || m.cleaned_text || m.raw_text || '').join(' '),
      settings
    )

    const createdActions: ActionProposal[] = []

    // Get existing pending actions so we can compare urgency before skipping
    const existingPending = await getPendingActionsByType(conversation.id)

    // Skip SCHEDULE if conversation already has a future confirmed event (not holds)
    // Holds are supersedable — they're tentative. Only confirmed events block.
    const hasEvent = await hasActiveEventForConversation(conversation.user_id, conversation.id)
    if (hasEvent && !existingPending.has('SCHEDULE')) {
      // Active event but no pending SCHEDULE action — event is confirmed, block new SCHEDULE
      existingPending.set('SCHEDULE', { id: '__event__', urgency: Infinity, intent_cs: null })
    }
    // If both an event AND a pending SCHEDULE exist, the pending action's urgency governs dedup (not Infinity)

    // Dedup with urgency comparison:
    // - No existing pending of this type → keep proposal
    // - Existing pending has LOWER urgency → update existing action (don't create new)
    // - Existing pending has EQUAL or HIGHER urgency → skip
    const seenTypes = new Set<string>()
    const updatedActionIds: string[] = []
    const dedupedProposals = proposals.filter(p => {
      if (seenTypes.has(p.actionType)) return false
      seenTypes.add(p.actionType)

      const existing = existingPending.get(p.actionType)
      if (!existing) return true

      // Confirmed event with no pending action — block
      if (existing.id === '__event__') return false

      // New proposal has higher urgency → will update existing action
      if (p.urgency > existing.urgency) {
        updatedActionIds.push(existing.id)
        return true
      }

      // Same or lower urgency — skip
      return false
    })

    for (const proposal of dedupedProposals) {
      // Validate and write deal_type onto conversation thread if AI classified it
      const dealType = validateDealType(proposal.dealType)
      if (dealType) {
        await updateConversation(conversation.id, { deal_type: dealType })
      }

      // SCHEDULE actions: store scheduling context for the batch optimizer.
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

        // Address confidence handling:
        // - Code said 'low' confidence → flag for user verification even if geocode succeeded
        // - No location at all → add missing_info asking user for the address
        if (proposal.locationConfidence === 'low' && meetingLocation) {
          locationPartial = true
        }

        // Only ask for address if this is an in-person meeting
        if (!isRemoteMeeting && !meetingLocation) {
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
          cp_availability: null,
          duration: settings.default_meeting_duration,
          meeting_type: proposedMeetingType,
          is_online: proposedMeetingType === 'online',
          cp_phone: proposal.cpPhone || null,
        }
      }

      const weight = proposal.immovable ? 100 : (proposal.weight || 0)
      const priorityScore = calculatePriorityScore({
        dollarValue: proposal.dollarValue,
        urgency: proposal.urgency,
        daysIgnored,
        sellerMultiplier: offerMultiplier,
        kcHighValue: settings.kc_high_value,
        weight,
      })

      // Supersede: if this proposal replaces a lower-urgency pending action, dismiss the old one
      const superseded = existingPending.get(proposal.actionType)
      if (superseded && updatedActionIds.includes(superseded.id)) {
        await dismissAction(superseded.id, conversation.user_id)
        console.log(`[Planning] Superseded ${proposal.actionType} (urgency ${superseded.urgency} → ${proposal.urgency}) for ${cp.name || cp.primary_identifier}`)
      }

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

  return generateFinalDraft(
    conversation.summary_json,
    userIntent || action.intent_cs || action.rationale_cs || action.rationale,
    settings,
    undefined,
    (action.missing_info as { label: string; value: string | null }[] | null) || undefined,
    cp?.name || cp?.primary_identifier || undefined,
    channel,
    formatTimelineForPrompt(draftCtx.timeline),
    formatJournalForPrompt(draftCtx.journal) || undefined
  )
}
