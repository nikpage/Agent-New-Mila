/**
 * Core Scheduling Service
 * Handles all calendar scheduling logic for Mila
 *
 * Key responsibilities:
 * - Find best available slots considering working hours, holidays, travel
 * - Block ONE optimal slot per meeting (single hold, not multiple options)
 * - Batch optimize ALL pending SCHEDULE actions before brief
 * - Optimization priority: CP availability > user availability > travel > conflict resolution
 * - Handle conflicts using priority scoring
 * - Calculate and book travel buffers
 * - Confirm/reject holds
 * - Coordinate multi-CP scheduling
 */

import {
  findFreeSlots,
  checkConflicts,
  createTentativeCalendarEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  confirmCalendarEvent,
  respondToInvitation,
  MILA_BLOCK_GROUP_KEY,
  type CalendarEvent,
} from '@/lib/google/calendar'
import {
  createEvent,
  createHoldEvent,
  createTravelBuffer,
  findConflicts,
  getEventById,
  updateEvent,
  deleteEvent,
  confirmEvent,
  cancelEventWithCleanup,
  cleanupTravelBuffers,
  calculateEventScore,
  getLastEventLocation,
} from '@/lib/db/events'
import { getUserSettings } from '@/lib/db/users'
import { getUserById } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { calculatePriorityScore, getPendingScheduleActions, updateAction } from '@/lib/db/actions'
import { getTravelTime, calculateDepartureTime } from '@/lib/google/maps'
import { isWorkingDay, getNextWorkingDay } from '@/lib/holidays'
import { generateSchedulingIntent } from '@/lib/ai/mila-voice'
import type { UserSettings, Event, ActionProposal } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

const MIN_TRAVEL_BUFFER_MINUTES = 15

export interface SlotProposal {
  start: Date
  end: Date
  travelBufferMinutes?: number
  departureTime?: Date
}

export interface SchedulingResult {
  success: boolean
  holdEvent?: Event
  gcalEventId?: string
  conflicts?: ConflictInfo[]
  error?: string
}

export interface MoveSuggestion {
  existingEventId: string
  existingWeight: number | null
  reason: string
}

export interface OptimizeResult {
  optimized: number
  unscheduled: number
  moveSuggestions: MoveSuggestion[]
  holds: Event[]
}

export interface ConflictInfo {
  existingEvent: Event
  existingScore: number
  newScore: number
  recommendation: 'move_existing' | 'suggest_alternate'
}

/**
 * Find the best available slots for a meeting
 * Considers working hours, holidays, travel time, and existing events
 */
export async function findBestSlots(
  userId: string,
  durationMinutes: number,
  numberOfSlots: number = 3,
  preferredDate?: Date,
  location?: string
): Promise<SlotProposal[]> {
  const settings = await getUserSettings(userId)
  const proposals: SlotProposal[] = []

  // Start from preferred date or tomorrow
  let searchDate = preferredDate || new Date()
  if (!preferredDate) {
    searchDate.setDate(searchDate.getDate() + 1)
  }

  // Search up to 14 days ahead to find enough slots
  const maxSearchDays = 14
  let daysSearched = 0

  while (proposals.length < numberOfSlots && daysSearched < maxSearchDays) {
    // Skip non-working days (weekends + CZ holidays)
    if (!isWorkingDay(searchDate, settings.working_days)) {
      searchDate = getNextWorkingDay(searchDate, settings.working_days)
      daysSearched++
      continue
    }

    // Find free slots on this day from Google Calendar
    // meeting_buffer_minutes ensures a gap between events (transition time)
    const freeSlots = await findFreeSlots(
      userId,
      searchDate,
      durationMinutes,
      settings.working_hours_start,
      settings.working_hours_end,
      settings.meeting_buffer_minutes
    )

    for (const slot of freeSlots) {
      if (proposals.length >= numberOfSlots) break

      const proposal: SlotProposal = {
        start: slot.start,
        end: slot.end,
      }

      // Calculate travel buffer if location is provided
      if (location) {
        const travelInfo = await calculateTravelForSlot(
          userId,
          slot.start,
          location,
          settings
        )

        if (travelInfo) {
          proposal.travelBufferMinutes = travelInfo.bufferMinutes
          proposal.departureTime = travelInfo.departureTime
        }
      }

      proposals.push(proposal)
    }

    // Move to next day
    searchDate = new Date(searchDate)
    searchDate.setDate(searchDate.getDate() + 1)
    daysSearched++
  }

  return proposals
}

/**
 * Calculate travel time and buffer for a given slot
 */
async function calculateTravelForSlot(
  userId: string,
  slotStart: Date,
  meetingLocation: string,
  settings: UserSettings
): Promise<{ bufferMinutes: number; departureTime: Date } | null> {
  // Find where user will be before this meeting
  const previousLocation = await getLastEventLocation(userId, slotStart)
  const origin = previousLocation || settings.office_location || settings.home_location

  if (!origin || !meetingLocation) return null

  // Always driving — no configurable travel mode
  const travelTime = await getTravelTime(origin, meetingLocation, 'driving')

  if (!travelTime) return null

  // ≤500m = walking distance, use flat 15min buffer (no travel calc needed)
  // >500m = driving, use Maps travel time with formula
  let travelBufferMinutes: number
  if (travelTime.distanceMeters <= 500) {
    travelBufferMinutes = MIN_TRAVEL_BUFFER_MINUTES
  } else {
    const travelMinutes = Math.ceil(travelTime.durationSeconds / 60)
    travelBufferMinutes = Math.max(travelMinutes + 10, MIN_TRAVEL_BUFFER_MINUTES)
  }

  // Total = standard meeting buffer + travel buffer
  const bufferMinutes = settings.meeting_buffer_minutes + travelBufferMinutes

  const departureTime = new Date(slotStart.getTime() - bufferMinutes * 60 * 1000)

  return { bufferMinutes, departureTime }
}

/**
 * Block ONE optimal slot in user's calendar for a meeting proposal
 * Creates a single tentative HOLD event (spec: one hold per meeting)
 */
export async function blockSlotForProposal(
  userId: string,
  cpId: string,
  slot: SlotProposal,
  durationMinutes: number,
  location?: string,
  weight?: number
): Promise<SchedulingResult> {
  const cp = await getCPById(cpId)
  if (!cp) {
    return { success: false, error: 'Counterparty not found' }
  }

  const cpName = cp.name || cp.primary_identifier
  const holdTitle = `${cpName} - REZERVACE`

  try {
    const gcalEvent = await createTentativeCalendarEvent(userId, {
      summary: holdTitle,
      description: `Tentative hold - awaiting confirmation from ${cpName}. Managed by Mila.`,
      location: location,
      startTime: slot.start,
      endTime: slot.end,
      status: 'tentative',
    })

    const localEvent = await createHoldEvent({
      userId,
      cpId,
      cpName,
      startTime: slot.start,
      endTime: slot.end,
      location: location,
      googleEventId: gcalEvent.id,
      weight: weight ?? undefined,
    })

    return {
      success: true,
      holdEvent: localEvent,
      gcalEventId: gcalEvent.id,
    }
  } catch (error) {
    console.error(`Failed to block slot:`, error)
    return { success: false, error: 'Failed to block slot' }
  }
}

/**
 * Confirm a hold event — becomes confirmed, invite sent to CP (spec step 8)
 * No block group cleanup needed — one hold per meeting
 */
export async function confirmSlot(
  userId: string,
  confirmedEventId: string,
  cpEmail?: string,
  location?: string,
  newTitle?: string,
  description?: string,
  isOnline?: boolean
): Promise<{ event: Event; travelBuffer?: Event }> {
  let confirmedEvent = await confirmEvent(confirmedEventId)

  if (newTitle) {
    confirmedEvent = await updateEvent(confirmedEventId, { title: newTitle })
  }

  // Google Meet conference data for online meetings
  const conferenceData = isOnline ? {
    createRequest: {
      requestId: `mila-${confirmedEventId}-${Date.now()}`,
      conferenceSolutionKey: { type: 'hangoutsMeet' },
    },
  } : undefined

  // Confirm on Google Calendar + send invite to CP
  if (confirmedEvent.google_event_id) {
    try {
      await confirmCalendarEvent(
        userId,
        confirmedEvent.google_event_id,
        cpEmail ? [cpEmail] : undefined,
        {
          summary: newTitle || confirmedEvent.title || 'Meeting',
          location: isOnline ? undefined : (location || confirmedEvent.location || undefined),
          description: description || undefined,
        },
        conferenceData
      )
    } catch (error) {
      console.error('Failed to confirm gcal event:', error)
    }
  } else if (cpEmail) {
    try {
      const gcalEvent = await createCalendarEvent(userId, {
        summary: confirmedEvent.title || 'Meeting',
        description: confirmedEvent.description || undefined,
        location: isOnline ? undefined : (location || confirmedEvent.location || undefined),
        startTime: new Date(confirmedEvent.start_time),
        endTime: new Date(confirmedEvent.end_time),
        attendees: [cpEmail],
        sendUpdates: 'all',
        conferenceData,
      })
      confirmedEvent = await updateEvent(confirmedEventId, { google_event_id: gcalEvent.id })
    } catch (error) {
      console.error('Failed to create confirmed gcal event with attendee:', error)
    }
  }

  // Book travel buffer if location is provided
  let travelBuffer: Event | undefined
  if (location || confirmedEvent.location) {
    try {
      const buffer = await bookTravelBuffer(
        userId,
        confirmedEvent,
        location || confirmedEvent.location || ''
      )
      travelBuffer = buffer || undefined
    } catch (error) {
      console.error('Failed to book travel buffer:', error)
    }
  }

  return { event: confirmedEvent, travelBuffer }
}

/**
 * Reject a hold event — cleared from DB and Google Calendar (spec step 9)
 */
export async function rejectSlot(
  userId: string,
  eventId: string
): Promise<void> {
  const event = await getEventById(eventId)
  if (!event) return

  // Delete from local DB
  await deleteEvent(eventId)

  // Delete from Google Calendar
  if (event.google_event_id) {
    try {
      await deleteCalendarEvent(userId, event.google_event_id, 'none')
    } catch (error) {
      console.error('Failed to delete gcal hold:', error)
    }
  }
}

/**
 * Book a travel buffer event for a meeting
 * Buffer is a separate event tied to the main one via parent_event_id
 */
async function bookTravelBuffer(
  userId: string,
  parentEvent: Event,
  meetingLocation: string
): Promise<Event | null> {
  const settings = await getUserSettings(userId)
  const eventStart = new Date(parentEvent.start_time)

  // Find origin (previous event location or home/office)
  const previousLocation = await getLastEventLocation(userId, eventStart)
  const origin = previousLocation || settings.office_location || settings.home_location

  if (!origin || !meetingLocation) return null

  // Always driving — no configurable travel mode
  const travelTime = await getTravelTime(origin, meetingLocation, 'driving')
  if (!travelTime) return null

  // ≤500m = walking distance, flat 15min buffer
  // >500m = driving, use Maps travel time with formula
  let travelBufferMinutes: number
  if (travelTime.distanceMeters <= 500) {
    travelBufferMinutes = MIN_TRAVEL_BUFFER_MINUTES
  } else {
    const travelMinutes = Math.ceil(travelTime.durationSeconds / 60)
    travelBufferMinutes = Math.max(travelMinutes + 10, MIN_TRAVEL_BUFFER_MINUTES)
  }
  const totalBufferMinutes = settings.meeting_buffer_minutes + travelBufferMinutes

  const bufferStart = new Date(eventStart.getTime() - totalBufferMinutes * 60 * 1000)
  const bufferEnd = new Date(eventStart)

  // User can leave before working hours (e.g., 8:30 departure for 9:00 meeting)
  // So we don't enforce working hours on the buffer start time

  // Create travel buffer in Google Calendar first to get the GCal ID
  let gcalEventId: string | undefined
  try {
    const gcalBuffer = await createTentativeCalendarEvent(userId, {
      summary: `🚗 Travel to ${parentEvent.title || 'meeting'}`,
      description: `Travel from ${origin} to ${meetingLocation} (${travelTime.durationText}). Auto-managed by Mila.`,
      startTime: bufferStart,
      endTime: bufferEnd,
      status: 'confirmed',
    })
    gcalEventId = gcalBuffer.id
  } catch (error) {
    console.error('Failed to create travel buffer in Google Calendar:', error)
  }

  // Create travel buffer in local DB — inherit weight from parent event
  const buffer = await createTravelBuffer({
    userId,
    parentEventId: parentEvent.id,
    startTime: bufferStart,
    endTime: bufferEnd,
    fromLocation: origin,
    toLocation: meetingLocation,
    travelDurationText: travelTime.durationText,
    googleEventId: gcalEventId,
    weight: parentEvent.weight ?? undefined,
  })

  return buffer
}

/**
 * Handle a scheduling conflict using priority scores
 * Decides whether to move the existing meeting or suggest an alternate time
 *
 * Rule: Use priority scores to assess if we should suggest moving
 * the already planned meeting or suggesting an alternate time to the CP
 */
export async function handleConflict(
  userId: string,
  proposedStart: Date,
  proposedEnd: Date,
  newEventScore: number,
  newCpId: string
): Promise<ConflictInfo[]> {
  const conflicts = await findConflicts(userId, proposedStart, proposedEnd)
  const conflictInfos: ConflictInfo[] = []

  for (const existing of conflicts) {
    // If weight is NULL, user hasn't set it — don't move this event
    if (existing.weight == null) {
      conflictInfos.push({
        existingEvent: existing,
        existingScore: Infinity,
        newScore: newEventScore,
        recommendation: 'suggest_alternate',
      })
      continue
    }

    // Use the stored weight from the event record
    const existingScore = calculateEventScore({
      weight: existing.weight,
    })

    const recommendation: 'move_existing' | 'suggest_alternate' =
      newEventScore > existingScore ? 'move_existing' : 'suggest_alternate'

    conflictInfos.push({
      existingEvent: existing,
      existingScore,
      newScore: newEventScore,
      recommendation,
    })
  }

  return conflictInfos
}

/**
 * Clean up when a main event is canceled or moved
 * Removes associated travel buffers
 */
export async function cleanupForCanceledEvent(
  userId: string,
  eventId: string
): Promise<void> {
  await cancelEventWithCleanup(eventId)
}

/**
 * Clean up when a main event is moved to a new time
 * Removes old travel buffers and recalculates new ones
 */
export async function handleEventMoved(
  userId: string,
  eventId: string,
  newStart: Date,
  newEnd: Date,
  location?: string
): Promise<Event | null> {
  // Clean up old travel buffers
  await cleanupTravelBuffers(eventId)

  // Update the event
  await updateEvent(eventId, {
    start_time: newStart.toISOString(),
    end_time: newEnd.toISOString(),
  })

  // Recalculate travel buffer if location provided
  if (location) {
    const event = await getEventById(eventId)
    if (event) {
      return bookTravelBuffer(userId, event, location)
    }
  }

  return null
}

/**
 * Schedule a meeting for a single CP
 * Picks ONE optimal slot and creates ONE hold (spec: one slot per meeting)
 */
export async function proposeMeeting(
  userId: string,
  cpId: string,
  durationMinutes?: number,
  location?: string,
  preferredDate?: Date
): Promise<SchedulingResult> {
  const settings = await getUserSettings(userId)
  const duration = durationMinutes || settings.default_meeting_duration

  // When a specific time was stated (e.g., "notary at 9:00 AM"),
  // treat it as a hard constraint — check that exact slot first.
  // Spec: CP availability is #1 priority in scheduling optimization.
  if (preferredDate) {
    const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
    const slotConflicts = await findConflicts(userId, preferredDate, preferredEnd)

    if (slotConflicts.length === 0) {
      // Exact requested time is free — book it directly
      const slot: SlotProposal = { start: preferredDate, end: preferredEnd }
      return blockSlotForProposal(userId, cpId, slot, duration, location)
    }

    // Stated time has a conflict — always book the hold (consistent process),
    // then return conflict info so the user or planning layer can act on it.
    const slot: SlotProposal = { start: preferredDate, end: preferredEnd }
    const holdResult = await blockSlotForProposal(userId, cpId, slot, duration, location)

    // Build conflict details for each conflicting event
    const conflictInfos: ConflictInfo[] = slotConflicts.map(existing => {
      const isImmovable = existing.weight == null || existing.weight >= 100
      return {
        existingEvent: existing,
        existingScore: existing.weight != null ? calculateEventScore({ weight: existing.weight }) : Infinity,
        newScore: 0, // caller computes final priority score
        recommendation: isImmovable ? 'suggest_alternate' as const : 'move_existing' as const,
      }
    })

    const hasImmovableConflict = conflictInfos.some(
      c => c.recommendation === 'suggest_alternate'
    )

    return {
      success: holdResult.success,
      holdEvent: holdResult.holdEvent,
      gcalEventId: holdResult.gcalEventId,
      conflicts: conflictInfos,
      error: hasImmovableConflict
        ? `Requested time conflicts with immovable event: ${slotConflicts.map(c => c.title || 'existing event').join(', ')}`
        : `Requested time conflicts with: ${slotConflicts.map(c => c.title || 'existing event').join(', ')}`,
    }
  }

  // No specific time stated — find the best available slot
  const slots = await findBestSlots(userId, duration, 10, undefined, location)

  if (slots.length === 0) {
    return {
      success: false,
      error: 'No available slots found in the next 14 days',
    }
  }

  // Pick the first conflict-free slot (they're already sorted by quality)
  for (const slot of slots) {
    const slotConflicts = await findConflicts(userId, slot.start, slot.end)

    if (slotConflicts.length === 0) {
      // No conflicts — block this one slot
      return blockSlotForProposal(userId, cpId, slot, duration, location)
    }
  }

  // All slots have conflicts
  return {
    success: false,
    error: 'All proposed slots have conflicts with higher-priority events',
  }
}

/**
 * For multiple CPs: ONE optimal slot, ONE hold (same as single-CP)
 */
export async function proposeMeetingMultipleCPs(
  userId: string,
  cpIds: string[],
  durationMinutes?: number,
  location?: string,
  preferredDate?: Date
): Promise<SchedulingResult> {
  const settings = await getUserSettings(userId)
  const duration = durationMinutes || settings.default_meeting_duration

  const slots = await findBestSlots(userId, duration, 10, preferredDate, location)

  if (slots.length === 0) {
    return { success: false, error: 'No available slots found' }
  }

  // Pick first conflict-free slot
  for (const slot of slots) {
    const slotConflicts = await findConflicts(userId, slot.start, slot.end)
    if (slotConflicts.length > 0) continue

    // Build title from all CP names
    const cpNames: string[] = []
    for (const cpId of cpIds) {
      const cp = await getCPById(cpId)
      if (cp) cpNames.push(cp.name || cp.primary_identifier)
    }
    const holdTitle = `${cpNames.join(', ')} - REZERVACE`

    try {
      const gcalEvent = await createTentativeCalendarEvent(userId, {
        summary: holdTitle,
        description: `Tentative hold - awaiting confirmation. Managed by Mila.`,
        location: location,
        startTime: slot.start,
        endTime: slot.end,
        status: 'tentative',
      })

      const localEvent = await createHoldEvent({
        userId,
        cpId: cpIds[0],
        cpName: cpNames[0] || cpIds[0],
        startTime: slot.start,
        endTime: slot.end,
        location: location,
        googleEventId: gcalEvent.id,
      })

      return { success: true, holdEvent: localEvent, gcalEventId: gcalEvent.id }
    } catch (error) {
      console.error('Failed to block slot for multi-CP meeting:', error)
      return { success: false, error: 'Failed to block slot' }
    }
  }

  return { success: false, error: 'All slots have conflicts' }
}

/**
 * Batch optimize ALL pending unsent SCHEDULE actions
 * Called before brief generation. Picks ONE optimal slot per meeting.
 *
 * Optimization priority (spec step 2):
 * 1. CP availability — stated or inferred from conversation
 * 2. User availability — free slots in calendar
 * 3. Travel optimization — cluster nearby meetings, avoid crossing town twice
 * 4. Conflict resolution (last resort) — only suggest moving existing events
 *    when CP is time-constrained AND priority is high. Prefer declining otherwise.
 */
export async function optimizeScheduleActions(
  userId: string
): Promise<OptimizeResult> {
  const actions = await getPendingScheduleActions(userId)
  const settings = await getUserSettings(userId)

  const result: OptimizeResult = {
    optimized: 0,
    unscheduled: 0,
    moveSuggestions: [],
    holds: [],
  }

  if (actions.length === 0) return result

  const bufferMinutes = settings.meeting_buffer_minutes ?? 15

  // Get all free slots for the next 14 days (enough to schedule all meetings)
  const allSlots = await findBestSlots(userId, settings.default_meeting_duration, 50)

  // Track booked time ranges (respects buffer on both sides)
  const bookedRanges: { start: Date; end: Date }[] = []

  function isSlotAvailable(slot: SlotProposal): boolean {
    for (const booked of bookedRanges) {
      const bufferMs = bufferMinutes * 60 * 1000
      // Slot must not overlap with booked range + buffer on both sides
      if (slot.start.getTime() < booked.end.getTime() + bufferMs &&
          slot.end.getTime() > booked.start.getTime() - bufferMs) {
        return false
      }
    }
    return true
  }

  // Sort actions by priority so highest-priority meetings get first pick
  const sortedActions = [...actions].sort(
    (a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0)
  )

  for (const action of sortedActions) {
    const payload = action.payload as Record<string, unknown> | null
    const cpAvailability = (payload?.cp_availability as string) || null
    const suggestedTime = (payload?.suggestedTime as string) || null
    const meetingLocation = (payload?.suggestedLocation as string) || (payload?.location as string) || null
    const duration = (payload?.duration as number) || settings.default_meeting_duration

    // If CP stated a specific time, parse it as a preferred date
    let preferredDate: Date | undefined
    if (suggestedTime) {
      try {
        const parsed = new Date(suggestedTime)
        if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now() - 86400000) {
          preferredDate = parsed
        }
      } catch {
        // Invalid date — ignore
      }
    }

    // If we have a preferred date, try that exact slot first (CP-stated = hard constraint)
    if (preferredDate) {
      const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
      const preferredSlot: SlotProposal = { start: preferredDate, end: preferredEnd }

      if (isSlotAvailable(preferredSlot)) {
        const conflicts = await findConflicts(userId, preferredDate, preferredEnd)

        if (conflicts.length === 0) {
          const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined)
          if (holdResult.success && holdResult.holdEvent) {
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            bookedRanges.push({ start: preferredDate, end: preferredEnd })
            continue
          }
        }

        // CP-stated time has a conflict — book anyway and report conflict
        const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined)
        if (holdResult.success && holdResult.holdEvent) {
          await updateActionWithHold(action, holdResult, meetingLocation, settings)
          result.optimized++
          result.holds.push(holdResult.holdEvent)
          bookedRanges.push({ start: preferredDate, end: preferredEnd })
          for (const conflict of conflicts) {
            result.moveSuggestions.push({
              existingEventId: conflict.id,
              existingWeight: conflict.weight,
              reason: `CP stated specific time: ${suggestedTime}`,
            })
          }
          continue
        }
      }
    }

    // No preferred date or preferred slot unavailable — find best available slot
    const availableSlots = allSlots.filter(s => isSlotAvailable(s))

    if (availableSlots.length === 0) {
      result.unscheduled++
      continue
    }

    // Priority 1: Filter by CP availability if stated
    let candidateSlots = availableSlots
    if (cpAvailability) {
      const cpFiltered = filterSlotsByCpAvailability(availableSlots, cpAvailability)
      if (cpFiltered.length > 0) {
        candidateSlots = cpFiltered
      }
      // If no CP-matching slots, fall through to all available (best effort)
    }

    // Priority 2: User availability — already handled by findBestSlots (only returns free slots)

    // Priority 3: Travel optimization — pick slot closest to other meetings' locations
    if (meetingLocation && candidateSlots.length > 1) {
      candidateSlots = await rankSlotsByTravel(
        userId, candidateSlots, meetingLocation, bookedRanges, settings
      )
    }

    // Try to find a conflict-free slot
    let scheduled = false
    for (const slot of candidateSlots) {
      const conflicts = await findConflicts(userId, slot.start, slot.end)

      if (conflicts.length === 0) {
        // No conflict — block this slot
        const holdResult = await blockSlotForProposal(
          userId,
          action.cp_id,
          slot,
          duration,
          meetingLocation || undefined
        )
        if (holdResult.success && holdResult.holdEvent) {
          await updateActionWithHold(action, holdResult, meetingLocation, settings)
          result.optimized++
          result.holds.push(holdResult.holdEvent)
          bookedRanges.push({ start: slot.start, end: slot.end })
          scheduled = true
          break
        }
      }
    }

    if (scheduled) continue

    // Priority 4: Conflict resolution (last resort)
    // Only suggest moving if CP is time-constrained
    if (cpAvailability) {
      // CP has a constraint — try to schedule at their required time
      // and suggest moving the conflicting event
      for (const slot of candidateSlots) {
        const conflicts = await findConflicts(userId, slot.start, slot.end)
        if (conflicts.length > 0) {
          // Schedule here and suggest moving the conflict
          const holdResult = await blockSlotForProposal(
            userId,
            action.cp_id,
            slot,
            duration,
            meetingLocation || undefined
          )
          if (holdResult.success && holdResult.holdEvent) {
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            bookedRanges.push({ start: slot.start, end: slot.end })
            for (const conflict of conflicts) {
              result.moveSuggestions.push({
                existingEventId: conflict.id,
                existingWeight: conflict.weight,
                reason: `CP can only meet at this time: ${cpAvailability}`,
              })
            }
            scheduled = true
            break
          }
        }
      }
    }

    if (!scheduled) {
      result.unscheduled++
    }
  }

  return result
}

/**
 * After creating a hold, update the action record with hold info and rewrite intent_cs.
 * This ensures the action card always matches the actual hold event.
 */
async function updateActionWithHold(
  action: ActionProposal,
  holdResult: SchedulingResult,
  meetingLocation: string | null,
  settings: UserSettings
): Promise<void> {
  if (!holdResult.holdEvent) return

  const hold = holdResult.holdEvent
  const start = new Date(hold.start_time)
  const end = new Date(hold.end_time)
  const payload = (action.payload as Record<string, unknown>) || {}

  const tz = 'Europe/Prague'
  const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })
  const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const slotText = `${dateStr}, ${startStr} - ${endStr}`

  const locationPartial = !!payload.location_partial
  let locationStatus: 'confirmed' | 'partial' | 'missing' | null = null
  if (!meetingLocation) locationStatus = 'missing'
  else if (locationPartial) locationStatus = 'partial'
  else locationStatus = 'confirmed'

  const conflicts = holdResult.conflicts?.map(c => ({
    name: c.existingEvent.title || 'existing event',
    recommendation: c.recommendation,
  }))

  // Rewrite intent_cs via mila-voice so the action card matches the hold
  let intentCs = action.intent_cs || ''
  try {
    const voiceResult = await generateSchedulingIntent(
      action.intent_cs || action.rationale_cs || '',
      {
        slotText,
        hasConflicts: !!(conflicts && conflicts.length > 0),
        conflicts,
        hasHold: true,
        locationStatus,
        locationText: meetingLocation || undefined,
      },
      hold.title?.replace(/^HOLD: Meeting with /, '') || '',
      action.urgency,
      action.rationale_cs || '',
      action.dollar_value || 0,
      '',
      settings
    )
    intentCs = voiceResult.intent_cs

    // Safety net: if AI dropped the hold time, force-include
    if (!intentCs.includes(startStr)) {
      intentCs = intentCs + '\n\nTermín: ' + slotText
    }
  } catch (voiceError) {
    console.error('[optimizer] generateSchedulingIntent failed, keeping original intent:', voiceError)
    // Append slot text to original intent as fallback
    intentCs = (action.intent_cs || '') + '\n\nTermín: ' + slotText
  }

  // Update the action record in DB
  await updateAction(action.id, {
    intent_cs: intentCs,
    payload: {
      ...payload,
      hold_event_id: hold.id,
      gcal_event_id: holdResult.gcalEventId || null,
      start: hold.start_time,
      end: hold.end_time,
      location: meetingLocation || null,
      is_online: false,
      conflicts: holdResult.conflicts?.map(c => ({
        event_id: c.existingEvent.id,
        event_title: c.existingEvent.title,
        recommendation: c.recommendation,
      })),
    },
  })
}

/**
 * Filter slots that match CP's stated availability (simple keyword matching)
 * E.g. "Tuesday afternoon" → filter to Tuesday PM slots
 */
function filterSlotsByCpAvailability(
  slots: SlotProposal[],
  cpAvailability: string
): SlotProposal[] {
  const lower = cpAvailability.toLowerCase()
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const czDayNames = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota']

  return slots.filter(slot => {
    const dayOfWeek = slot.start.getDay()
    const hour = slot.start.getHours()
    const dayName = dayNames[dayOfWeek]
    const czDayName = czDayNames[dayOfWeek]

    // Check day match
    const dayMatch = lower.includes(dayName) || lower.includes(czDayName)
    if (!dayMatch && (dayNames.some(d => lower.includes(d)) || czDayNames.some(d => lower.includes(d)))) {
      return false // CP specified a day and this isn't it
    }

    // Check time-of-day match
    const isAfternoon = hour >= 12
    const isMorning = hour < 12
    if (lower.includes('afternoon') || lower.includes('odpoledne')) {
      if (!isAfternoon) return false
    }
    if (lower.includes('morning') || lower.includes('ráno') || lower.includes('dopoledne')) {
      if (!isMorning) return false
    }

    // Check specific time match (e.g. "at 10:00" or "v 10:00")
    const timeMatch = lower.match(/(?:at|v)\s+(\d{1,2}):?(\d{2})?/)
    if (timeMatch) {
      const targetHour = parseInt(timeMatch[1])
      if (hour !== targetHour) return false
    }

    return true
  })
}

/**
 * Rank slots by travel efficiency — prefer slots near existing meetings
 * to minimize total travel time (avoid crossing town twice)
 */
async function rankSlotsByTravel(
  userId: string,
  slots: SlotProposal[],
  meetingLocation: string,
  _bookedRanges: { start: Date; end: Date }[],
  settings: UserSettings
): Promise<SlotProposal[]> {
  // Score each slot by travel time from the previous event
  const scored: { slot: SlotProposal; travelSeconds: number }[] = []

  for (const slot of slots) {
    const previousLocation = await getLastEventLocation(userId, slot.start)
    const origin = previousLocation || settings.office_location || settings.home_location

    if (!origin) {
      scored.push({ slot, travelSeconds: 0 })
      continue
    }

    const travelTime = await getTravelTime(origin, meetingLocation, 'driving')
    scored.push({ slot, travelSeconds: travelTime?.durationSeconds ?? Infinity })
  }

  // Sort by travel time (shortest first)
  scored.sort((a, b) => a.travelSeconds - b.travelSeconds)
  return scored.map(s => s.slot)
}

/**
 * Accept an incoming calendar invitation
 */
export async function acceptInvitation(
  userId: string,
  calendarEventId: string,
  location?: string
): Promise<{ success: boolean; travelBuffer?: Event }> {
  const user = await getUserById(userId)
  if (!user?.email) {
    return { success: false }
  }

  await respondToInvitation(userId, calendarEventId, 'accepted', user.email)

  // Book travel buffer if location is known
  let travelBuffer: Event | undefined
  if (location) {
    // Create a temporary event record to calculate travel
    const settings = await getUserSettings(userId)
    // We'd need to fetch the actual event to get start time, handled by caller
  }

  return { success: true, travelBuffer }
}

/**
 * Decline an incoming calendar invitation
 */
export async function declineInvitation(
  userId: string,
  calendarEventId: string
): Promise<{ success: boolean }> {
  const user = await getUserById(userId)
  if (!user?.email) {
    return { success: false }
  }

  await respondToInvitation(userId, calendarEventId, 'declined', user.email)
  return { success: true }
}

/**
 * Format slot proposals for display in Czech
 */
export function formatSlotsForDisplay(slots: SlotProposal[]): string[] {
  return slots.map((slot, index) => {
    const formatTime = (date: Date) => {
      return date.toLocaleTimeString('cs-CZ', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    }

    const formatDate = (date: Date) => {
      return date.toLocaleDateString('cs-CZ', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    }

    let text = `${index + 1}. ${formatDate(slot.start)}, ${formatTime(slot.start)} - ${formatTime(slot.end)}`

    if (slot.travelBufferMinutes) {
      text += ` (odjezd v ${formatTime(slot.departureTime!)})`
    }

    return text
  })
}
