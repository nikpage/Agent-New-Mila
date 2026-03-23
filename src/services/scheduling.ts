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
  findConflicts as findDbConflicts,
  getEventById,
  updateEvent,
  deleteEvent,
  confirmEvent,
  cancelEventWithCleanup,
  cleanupTravelBuffers,
  getTravelBuffers,
  calculateEventScore,
  getLastEventLocation,
} from '@/lib/db/events'
import { getUserSettings } from '@/lib/db/users'
import { getUserById } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { calculatePriorityScore, getPendingScheduleActions, updateAction, getActionsForUser } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getTravelTime, calculateDepartureTime } from '@/lib/google/maps'
import { isWorkingDay, getNextWorkingDay } from '@/lib/holidays'
import { generateSchedulingIntent } from '@/lib/ai/mila-voice'
import { runAITask } from '@/lib/ai/runner'
import type { TimePreference } from '@/lib/ai/gemini'
import type { UserSettings, Event, ActionProposal } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

const MIN_TRAVEL_BUFFER_MINUTES = 15

/**
 * Check for conflicts against BOTH Google Calendar and local DB.
 * Google Calendar has the user's real events (external appointments, etc).
 * Local DB has Mila-created holds and events.
 * Returns a unified list so nothing gets booked on top of existing events.
 */
async function findAllConflicts(
  userId: string,
  startTime: Date,
  endTime: Date,
  excludeEventId?: string
): Promise<Event[]> {
  // Check both sources in parallel
  const [gcalConflicts, dbConflicts] = await Promise.all([
    checkConflicts(userId, startTime, endTime).catch(err => {
      console.error('[scheduling] Google Calendar conflict check failed, falling back to DB only:', err)
      return [] as CalendarEvent[]
    }),
    findDbConflicts(userId, startTime, endTime, excludeEventId),
  ])

  // DB conflicts already have the right shape
  const result: Event[] = [...dbConflicts]

  // Track DB events by google_event_id so we don't double-count
  const dbGoogleIds = new Set(
    dbConflicts
      .map(e => (e as Record<string, unknown>).google_event_id as string | undefined)
      .filter(Boolean)
  )

  // Add Google Calendar events that aren't already in the DB
  for (const gcalEvent of gcalConflicts) {
    if (dbGoogleIds.has(gcalEvent.id)) continue

    // Convert CalendarEvent to Event shape for conflict handling.
    // These are real user calendar events — treat as immovable (weight=100)
    // since Mila has no authority over events she didn't create.
    // Carry attendees as _attendees for conflict resolution draft generation.
    const syntheticEvent = {
      id: gcalEvent.id,
      user_id: userId,
      title: gcalEvent.summary || 'Calendar event',
      start_time: gcalEvent.startTime.toISOString(),
      end_time: gcalEvent.endTime.toISOString(),
      location: gcalEvent.location || null,
      weight: 100,
      status: gcalEvent.status || 'confirmed',
      google_event_id: gcalEvent.id,
      created_at: new Date().toISOString(),
    } as Event
    // Attach attendees as non-schema property for conflict enrichment
    ;(syntheticEvent as Record<string, unknown>)._attendees = gcalEvent.attendees || []
    result.push(syntheticEvent)
  }

  return result
}

export interface SlotProposal {
  start: Date
  end: Date
  travelBufferMinutes?: number
  departureTime?: Date
}

export interface SchedulingResult {
  success: boolean
  holdEvent?: Event
  travelBufferEvent?: Event
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
  /** GCal attendees on the conflicting event (email + name), for drafting reschedule/cancel messages */
  attendees?: { email: string; name?: string }[]
}

// Re-export ConflictCardData from action-card-template (single source of truth)
import type { ConflictCardData } from '@/components/action/action-card-template'
export type { ConflictCardData } from '@/components/action/action-card-template'

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
  weight?: number,
  conversationId?: string
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
      description: `Předběžná rezervace — čeká se na potvrzení od ${cpName}. Spravuje Mila.`,
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
      conversationId,
    })

    // Book travel buffer NOW — a hold without travel blocked is a hold the user can't reach.
    // Travel buffer is re-created at confirmation (confirmSlot cleans up and recalculates).
    let travelBufferEvent: Event | undefined
    if (location && localEvent) {
      try {
        const buffer = await bookTravelBuffer(userId, localEvent, location)
        travelBufferEvent = buffer || undefined
      } catch (error) {
        console.error('[blockSlotForProposal] Travel buffer failed (hold still valid):', error)
      }
    }

    return {
      success: true,
      holdEvent: localEvent,
      travelBufferEvent,
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

  // Clean up tentative travel buffer from hold phase, then re-create for confirmed event.
  // Origin location may have changed since the hold was created (other meetings moved),
  // so we always recalculate rather than keeping the tentative one.
  let travelBuffer: Event | undefined
  if (location || confirmedEvent.location) {
    try {
      const oldBuffers = await getTravelBuffers(confirmedEventId)
      for (const buf of oldBuffers) {
        if (buf.google_event_id) {
          await deleteCalendarEvent(userId, buf.google_event_id, 'none').catch(e =>
            console.error('Failed to delete old travel buffer from GCal:', e)
          )
        }
      }
      await cleanupTravelBuffers(confirmedEventId)
    } catch (error) {
      console.error('Failed to clean up tentative travel buffers:', error)
    }
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

  // Clean up travel buffer first — from GCal AND DB
  const travelBuffers = await getTravelBuffers(eventId)
  for (const buffer of travelBuffers) {
    if (buffer.google_event_id) {
      try {
        await deleteCalendarEvent(userId, buffer.google_event_id, 'none')
      } catch (error) {
        console.error('Failed to delete travel buffer from GCal:', error)
      }
    }
  }
  await cleanupTravelBuffers(eventId)

  // Delete hold from local DB
  await deleteEvent(eventId)

  // Delete hold from Google Calendar
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
      summary: `🚗 Cesta na ${parentEvent.title || 'schůzku'}`,
      description: `Cesta z ${origin} do ${meetingLocation} (${travelTime.durationText}). Spravuje Mila.`,
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
  const conflicts = await findAllConflicts(userId, proposedStart, proposedEnd)
  const conflictInfos: ConflictInfo[] = []

  for (const existing of conflicts) {
    const rawAttendees = ((existing as Record<string, unknown>)._attendees as { email: string; name?: string }[]) || []

    // If weight is NULL, user hasn't set it — don't move this event
    if (existing.weight == null) {
      conflictInfos.push({
        existingEvent: existing,
        existingScore: Infinity,
        newScore: newEventScore,
        recommendation: 'suggest_alternate',
        attendees: rawAttendees,
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
      attendees: rawAttendees,
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
  // Clean up old travel buffers — GCal + DB
  const oldBuffers = await getTravelBuffers(eventId)
  for (const buf of oldBuffers) {
    if (buf.google_event_id) {
      await deleteCalendarEvent(userId, buf.google_event_id, 'none').catch(e =>
        console.error('Failed to delete old travel buffer from GCal:', e)
      )
    }
  }
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

  // All slots — preferred or not — validated against Google Calendar free slots.
  // findBestSlots calls findFreeSlots which reads the real calendar.
  const slots = await findBestSlots(userId, duration, 10, preferredDate, location)

  if (preferredDate) {
    const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
    const preferredSlot: SlotProposal = { start: preferredDate, end: preferredEnd }

    // Check if preferred time is within a known free slot
    const isFree = slots.some(free =>
      free.start.getTime() <= preferredDate!.getTime() &&
      free.end.getTime() >= preferredEnd.getTime()
    )

    if (isFree) {
      // Genuinely free — book it
      return blockSlotForProposal(userId, cpId, preferredSlot, duration, location)
    }

    // Preferred time conflicts — do NOT blindly double-book.
    // Fall through to normal slot selection (picks nearest free slot).
    // The caller's intent/rationale still references the CP's preferred time,
    // so the user sees what was requested vs. what Mila actually booked.
  }

  // No preferred date — pick first free slot (already GCal-validated)
  if (slots.length === 0) {
    return {
      success: false,
      error: 'No available slots found in the next 14 days',
    }
  }

  // Slots are already free per Google Calendar. Pick the first one.
  return blockSlotForProposal(userId, cpId, slots[0], duration, location)
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

  // Slots are already GCal-validated (free per Google Calendar). Pick the first one.
  for (const slot of slots) {
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
        description: `Předběžná rezervace — čeká se na potvrzení. Spravuje Mila.`,
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

  // Track booked time ranges INCLUDING travel buffers (respects buffer on both sides)
  const bookedRanges: { start: Date; end: Date }[] = []

  // Compute the full blocked range: travel buffer start → meeting end
  function bookedRangeForHold(meetingStart: Date, meetingEnd: Date, holdResult: SchedulingResult): { start: Date; end: Date } {
    const rangeStart = holdResult.travelBufferEvent?.start_time
      ? new Date(holdResult.travelBufferEvent.start_time)
      : meetingStart
    return { start: rangeStart, end: meetingEnd }
  }

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

  // Sort actions by CP time constraint tightness (most constrained first).
  // Per spec: CP availability is #1 optimization priority — NOT priority_score.
  // Actions with timePreferences get scheduled first so they claim
  // their constrained slot before flexible actions fill the gaps.
  const sortedActions = [...actions].sort((a, b) => {
    const payloadA = a.payload as Record<string, unknown> | null
    const payloadB = b.payload as Record<string, unknown> | null
    const prefsA = (payloadA?.timePreferences as TimePreference[]) || []
    const rawAvailA = (payloadA?.cpAvailabilityRaw as string) || null
    const prefsB = (payloadB?.timePreferences as TimePreference[]) || []
    const rawAvailB = (payloadB?.cpAvailabilityRaw as string) || null

    // Constraint score: structured preferences = 3, raw availability text = 2, none = 1
    const constraintA = prefsA.length > 0 ? 3 : rawAvailA ? 2 : 1
    const constraintB = prefsB.length > 0 ? 3 : rawAvailB ? 2 : 1

    if (constraintA !== constraintB) return constraintB - constraintA

    // Within same constraint level, break ties by urgency (higher first)
    return (b.urgency ?? 1) - (a.urgency ?? 1)
  })

  for (const action of sortedActions) {
    const payload = action.payload as Record<string, unknown> | null

    // Already has a hold — don't double-book by creating another one.
    // This prevents the instant-notify → brief pipeline from booking twice.
    if (payload?.hold_event_id) {
      console.log(`[optimizer] Action ${action.id} already has hold ${payload.hold_event_id} — skipping`)
      // Still track the existing hold's time range so subsequent actions don't overlap
      if (payload.start && payload.end) {
        bookedRanges.push({
          start: new Date(payload.start as string),
          end: new Date(payload.end as string),
        })
      }
      continue
    }

    const preferences = (payload?.timePreferences as TimePreference[]) || []
    const cpAvailabilityRaw = (payload?.cpAvailabilityRaw as string) || null
    const payloadMeetingType = (payload?.meeting_type as string) || 'address'
    // Phone and online meetings don't need a physical location — skip travel buffer
    const meetingLocation = (payloadMeetingType === 'phone' || payloadMeetingType === 'online')
      ? null
      : (payload?.suggestedLocation as string) || (payload?.location as string) || null
    const duration = (payload?.duration as number) || settings.default_meeting_duration

    // ── Preference-based slot selection ──────────────────────────────
    // Try each time preference in rank order. For each preference:
    // 1. Parse the time and compute a flexibility window
    // 2. Check if a free slot exists in that window
    // 3. If free → book it. If conflict → compare priorities. If conflict too strong → next preference.
    let preferenceBooked = false

    if (preferences.length > 0) {
      const sortedPrefs = [...preferences].sort((a, b) => a.rank - b.rank)

      for (const pref of sortedPrefs) {
        const preferredDate = parseTimePreferenceToPragueDate(pref.time)
        if (!preferredDate) continue

        // Compute flexibility window
        const windowMinutes = pref.flexibility === 'exact' ? 0
          : pref.flexibility === 'approximate' ? 30
          : 180 // loose = ±3 hours

        const windowStart = new Date(preferredDate.getTime() - windowMinutes * 60000)
        const windowEnd = new Date(preferredDate.getTime() + windowMinutes * 60000)
        const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
        const preferredSlot: SlotProposal = { start: preferredDate, end: preferredEnd }

        // For exact/approximate: check if the preferred slot itself is free
        // For loose: find any free slot in the window
        if (pref.flexibility === 'loose') {
          // Find free slots in the window
          const windowSlots = allSlots.filter(s =>
            s.start.getTime() >= windowStart.getTime() &&
            s.start.getTime() <= windowEnd.getTime() &&
            isSlotAvailable(s)
          )
          if (windowSlots.length > 0) {
            // Pick the slot closest to the preferred time
            const closest = windowSlots.sort((a, b) =>
              Math.abs(a.start.getTime() - preferredDate.getTime()) -
              Math.abs(b.start.getTime() - preferredDate.getTime())
            )[0]
            const holdResult = await blockSlotForProposal(userId, action.cp_id, closest, duration, meetingLocation || undefined, undefined, action.conversation_id)
            if (holdResult.success && holdResult.holdEvent) {
              await updateActionWithHold(action, holdResult, meetingLocation, settings)
              result.optimized++
              result.holds.push(holdResult.holdEvent)
              bookedRanges.push(bookedRangeForHold(closest.start, closest.end, holdResult))
              preferenceBooked = true
              break
            }
          }
          // No free slot in window — try next preference
          continue
        }

        // exact or approximate: check preferred slot directly
        // CP stated a specific time — respect it even if outside working hours/days.
        let preferredSlotIsFree = allSlots.some(free =>
          free.start.getTime() <= preferredDate.getTime() &&
          free.end.getTime() >= preferredEnd.getTime()
        )

        if (!preferredSlotIsFree) {
          const daySlots = await findFreeSlots(
            userId, preferredDate, duration,
            settings.working_hours_start, settings.working_hours_end,
            settings.meeting_buffer_minutes
          )
          preferredSlotIsFree = daySlots.some(free =>
            free.start.getTime() <= preferredDate.getTime() &&
            free.end.getTime() >= preferredEnd.getTime()
          )
        }

        if (preferredSlotIsFree && isSlotAvailable(preferredSlot)) {
          const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined, undefined, action.conversation_id)
          if (holdResult.success && holdResult.holdEvent) {
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            bookedRanges.push(bookedRangeForHold(preferredDate, preferredEnd, holdResult))
            preferenceBooked = true
            break
          }
        } else if (pref.flexibility === 'approximate') {
          // approximate: try nearby free slots (±30min) before giving up
          const nearbySlots = allSlots.filter(s =>
            Math.abs(s.start.getTime() - preferredDate.getTime()) <= 30 * 60000 &&
            s.start.getTime() !== preferredDate.getTime() &&
            isSlotAvailable(s)
          ).sort((a, b) =>
            Math.abs(a.start.getTime() - preferredDate.getTime()) -
            Math.abs(b.start.getTime() - preferredDate.getTime())
          )
          for (const nearby of nearbySlots) {
            const holdResult = await blockSlotForProposal(userId, action.cp_id, nearby, duration, meetingLocation || undefined, undefined, action.conversation_id)
            if (holdResult.success && holdResult.holdEvent) {
              await updateActionWithHold(action, holdResult, meetingLocation, settings)
              result.optimized++
              result.holds.push(holdResult.holdEvent)
              bookedRanges.push(bookedRangeForHold(nearby.start, nearby.end, holdResult))
              preferenceBooked = true
              break
            }
          }
          if (preferenceBooked) break
          // No nearby slot — try next preference
        } else if (pref.flexibility === 'exact' && isSlotAvailable(preferredSlot)) {
          // exact: conflict resolution — suggest moving, never auto-move
          const conflicts = await findAllConflicts(userId, preferredDate, preferredEnd)
          const newScore = action.priority_score ?? 0

          const allConflictsMovable = conflicts.length > 0 && conflicts.every(existing => {
            const w = existing.weight ?? 7
            return w < 100 && newScore > calculateEventScore({ weight: w })
          })

          if (allConflictsMovable) {
            const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined, undefined, action.conversation_id)
            if (holdResult.success && holdResult.holdEvent) {
              const conflictInfos: ConflictInfo[] = conflicts.map(existing => ({
                existingEvent: existing,
                existingScore: calculateEventScore({ weight: existing.weight ?? 7 }),
                newScore,
                recommendation: 'move_existing' as const,
              }))
              holdResult.conflicts = conflictInfos
              for (const conflict of conflicts) {
                result.moveSuggestions.push({
                  existingEventId: conflict.id,
                  existingWeight: conflict.weight,
                  reason: `CP stated specific time: ${pref.source_phrase || pref.time}`,
                })
              }
              await updateActionWithHold(action, holdResult, meetingLocation, settings)
              result.optimized++
              result.holds.push(holdResult.holdEvent)
              bookedRanges.push(bookedRangeForHold(preferredDate, preferredEnd, holdResult))
              preferenceBooked = true
              break
            }
          }
          // Conflict too strong — try next preference
        }
        // Preferred slot failed or no resolution — try next preference
      }
    }

    if (preferenceBooked) continue

    // Normal path: pick from GCal-validated free slots
    const availableSlots = allSlots.filter(s => isSlotAvailable(s))

    if (availableSlots.length === 0) {
      result.unscheduled++
      continue
    }

    // Score slots against preferences (fallback scoring) or use LLM escape hatch
    let candidateSlots: SlotProposal[] = availableSlots
    if (preferences.length > 0) {
      const scored = scoreSlotsAgainstPreferences(availableSlots, preferences)
      if (scored.length > 0) candidateSlots = scored
    } else if (cpAvailabilityRaw) {
      const llmScored = await llmEscapeHatchScoring(availableSlots, cpAvailabilityRaw)
      if (llmScored.length > 0) candidateSlots = llmScored
    }

    // Priority 2: User availability — already handled by findBestSlots (only returns free slots)

    // Priority 3: Travel optimization — pick slot closest to other meetings' locations
    if (meetingLocation && candidateSlots.length > 1) {
      candidateSlots = await rankSlotsByTravel(
        userId, candidateSlots, meetingLocation, bookedRanges, settings
      )
    }

    // All candidateSlots are already GCal-free. Pick the first batch-available one.
    let scheduled = false
    for (const slot of candidateSlots) {
      const holdResult = await blockSlotForProposal(
        userId,
        action.cp_id,
        slot,
        duration,
        meetingLocation || undefined,
        undefined,
        action.conversation_id
      )
      if (holdResult.success && holdResult.holdEvent) {
        await updateActionWithHold(action, holdResult, meetingLocation, settings)
        result.optimized++
        result.holds.push(holdResult.holdEvent)
        bookedRanges.push(bookedRangeForHold(slot.start, slot.end, holdResult))
        scheduled = true
        break
      }
    }

    if (!scheduled) {
      result.unscheduled++
    }
  }

  return result
}

/**
 * Schedule a single SCHEDULE action through the standard rules.
 * Used by instant notify — processes only the urgent action, not the full batch.
 * Same logic as the batch optimizer but without bookedRanges tracking.
 */
export async function scheduleSingleAction(
  action: ActionProposal
): Promise<OptimizeResult> {
  const userId = action.user_id
  const settings = await getUserSettings(userId)
  const payload = action.payload as Record<string, unknown> | null

  const result: OptimizeResult = {
    optimized: 0,
    unscheduled: 0,
    moveSuggestions: [],
    holds: [],
  }

  if (action.action_type !== 'SCHEDULE') return result

  // Already has a hold — don't double-book by creating another one.
  // This prevents the instant-notify → brief pipeline from booking twice.
  if (payload?.hold_event_id) {
    console.log(`[scheduleSingleAction] Action ${action.id} already has hold ${payload.hold_event_id} — skipping`)
    return result
  }

  const preferences = (payload?.timePreferences as TimePreference[]) || []
  const cpAvailabilityRaw = (payload?.cpAvailabilityRaw as string) || null
  const singleMeetingType = (payload?.meeting_type as string) || 'address'
  // Phone and online meetings don't need a physical location — skip travel buffer
  const meetingLocation = (singleMeetingType === 'phone' || singleMeetingType === 'online')
    ? null
    : (payload?.suggestedLocation as string) || (payload?.location as string) || null
  const duration = (payload?.duration as number) || settings.default_meeting_duration

  // ── Preference-based slot selection (mirrors batch optimizer) ──
  if (preferences.length > 0) {
    const sortedPrefs = [...preferences].sort((a, b) => a.rank - b.rank)

    for (const pref of sortedPrefs) {
      const preferredDate = parseTimePreferenceToPragueDate(pref.time)
      if (!preferredDate) continue

      const windowMinutes = pref.flexibility === 'exact' ? 0
        : pref.flexibility === 'approximate' ? 30
        : 180

      const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
      const preferredSlot: SlotProposal = { start: preferredDate, end: preferredEnd }

      if (pref.flexibility === 'loose') {
        const windowStart = new Date(preferredDate.getTime() - windowMinutes * 60000)
        const windowEndTime = new Date(preferredDate.getTime() + windowMinutes * 60000)
        const daySlots = await findFreeSlots(
          userId, windowStart, duration,
          settings.working_hours_start, settings.working_hours_end,
          settings.meeting_buffer_minutes
        )
        const windowSlots = daySlots.filter(s =>
          s.start.getTime() >= windowStart.getTime() &&
          s.start.getTime() <= windowEndTime.getTime()
        )
        if (windowSlots.length > 0) {
          const closest = windowSlots.sort((a, b) =>
            Math.abs(a.start.getTime() - preferredDate.getTime()) -
            Math.abs(b.start.getTime() - preferredDate.getTime())
          )[0]
          const holdResult = await blockSlotForProposal(userId, action.cp_id, closest, duration, meetingLocation || undefined, undefined, action.conversation_id)
          if (holdResult.success && holdResult.holdEvent) {
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            return result
          }
        }
        continue
      }

      // exact or approximate
      const daySlots = await findFreeSlots(
        userId, preferredDate, duration,
        settings.working_hours_start, settings.working_hours_end,
        settings.meeting_buffer_minutes
      )
      const preferredSlotIsFree = daySlots.some(free =>
        free.start.getTime() <= preferredDate.getTime() &&
        free.end.getTime() >= preferredEnd.getTime()
      )

      if (preferredSlotIsFree) {
        const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined, undefined, action.conversation_id)
        if (holdResult.success && holdResult.holdEvent) {
          await updateActionWithHold(action, holdResult, meetingLocation, settings)
          result.optimized++
          result.holds.push(holdResult.holdEvent)
          return result
        }
      } else if (pref.flexibility === 'approximate') {
        // approximate: try nearby free slots (±30min) before giving up
        const nearbySlots = daySlots.filter(s =>
          Math.abs(s.start.getTime() - preferredDate.getTime()) <= 30 * 60000 &&
          s.start.getTime() !== preferredDate.getTime()
        ).sort((a, b) =>
          Math.abs(a.start.getTime() - preferredDate.getTime()) -
          Math.abs(b.start.getTime() - preferredDate.getTime())
        )
        for (const nearby of nearbySlots) {
          const holdResult = await blockSlotForProposal(userId, action.cp_id, nearby, duration, meetingLocation || undefined, undefined, action.conversation_id)
          if (holdResult.success && holdResult.holdEvent) {
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            return result
          }
        }
        // No nearby slot — try next preference
      } else if (pref.flexibility === 'exact') {
        // exact: conflict resolution — suggest moving, never auto-move
        const conflicts = await findAllConflicts(userId, preferredDate, preferredEnd)
        const newScore = action.priority_score ?? 0

        const allConflictsMovable = conflicts.length > 0 && conflicts.every(existing => {
          const w = existing.weight ?? 7
          return w < 100 && newScore > calculateEventScore({ weight: w })
        })

        if (allConflictsMovable) {
          const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined, undefined, action.conversation_id)
          if (holdResult.success && holdResult.holdEvent) {
            const conflictInfos: ConflictInfo[] = conflicts.map(existing => ({
              existingEvent: existing,
              existingScore: calculateEventScore({ weight: existing.weight ?? 7 }),
              newScore,
              recommendation: 'move_existing' as const,
            }))
            holdResult.conflicts = conflictInfos
            for (const conflict of conflicts) {
              result.moveSuggestions.push({
                existingEventId: conflict.id,
                existingWeight: conflict.weight,
                reason: `CP stated specific time: ${pref.source_phrase || pref.time}`,
              })
            }
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            return result
          }
        }
        // Conflict too strong — try next preference
      }
    }
  }

  // No preference matched — find best free slot
  const allSlots = await findBestSlots(userId, duration, 20)

  let candidateSlots: SlotProposal[] = allSlots
  if (preferences.length > 0) {
    const scored = scoreSlotsAgainstPreferences(allSlots, preferences)
    if (scored.length > 0) candidateSlots = scored
  } else if (cpAvailabilityRaw) {
    const llmScored = await llmEscapeHatchScoring(allSlots, cpAvailabilityRaw)
    if (llmScored.length > 0) candidateSlots = llmScored
  }

  if (meetingLocation && candidateSlots.length > 1) {
    candidateSlots = await rankSlotsByTravel(
      userId, candidateSlots, meetingLocation, [], settings
    )
  }

  for (const slot of candidateSlots) {
    const holdResult = await blockSlotForProposal(userId, action.cp_id, slot, duration, meetingLocation || undefined, undefined, action.conversation_id)
    if (holdResult.success && holdResult.holdEvent) {
      await updateActionWithHold(action, holdResult, meetingLocation, settings)
      result.optimized++
      result.holds.push(holdResult.holdEvent)
      return result
    }
  }

  result.unscheduled++
  return result
}

/**
 * Enrich conflict data with CP name, deal context, alternative slot, and guest info.
 * This makes the conflict card actionable — user sees both sides and can resolve in one click.
 */
async function enrichConflictData(
  userId: string,
  conflictInfos: ConflictInfo[],
  settings: UserSettings
): Promise<ConflictCardData[]> {
  const enriched: ConflictCardData[] = []

  for (const conflict of conflictInfos) {
    const existing = conflict.existingEvent
    const cpId = (existing as Record<string, unknown>).cp_id as string | null || null
    const googleEventId = (existing as Record<string, unknown>).google_event_id as string | null || null

    // Get CP name
    let cpName: string | null = null
    if (cpId) {
      try {
        const cp = await getCPById(cpId)
        cpName = cp?.name || cp?.primary_identifier || null
      } catch { /* CP not found — ok */ }
    }

    // Get deal context from conversation (if this event was created by Mila)
    let dealContext: string | null = null
    if (cpId) {
      try {
        // Reverse lookup: find action whose hold_event_id matches this event
        const userActions = await getActionsForUser(userId, { actionType: 'SCHEDULE' })
        const originAction = userActions.find(a => {
          const p = a.payload as Record<string, unknown> | null
          return p?.hold_event_id === existing.id
        })
        if (originAction?.conversation_id) {
          const conv = await getConversationById(originAction.conversation_id)
          dealContext = conv?.summary_text || null
        }
      } catch { /* lookup failed — ok, deal_context stays null */ }
    }

    // Detect guests (GCal attendees, excluding the user themselves)
    const attendees = conflict.attendees || []
    const hasGuests = attendees.length > 0

    // Find ONE alternative slot for the existing event (quick GCal scan)
    const eventDuration = Math.round(
      (new Date(existing.end_time).getTime() - new Date(existing.start_time).getTime()) / 60000
    )
    let altSlotStart: string | null = null
    let altSlotEnd: string | null = null
    try {
      const altSlots = await findBestSlots(userId, eventDuration, 1)
      if (altSlots.length > 0) {
        altSlotStart = altSlots[0].start.toISOString()
        altSlotEnd = altSlots[0].end.toISOString()
      }
    } catch { /* slot search failed — no alt slot */ }

    enriched.push({
      event_id: existing.id,
      event_title: existing.title || 'Calendar event',
      event_start: existing.start_time,
      event_end: existing.end_time,
      event_weight: existing.weight ?? 7,
      event_score: conflict.existingScore === Infinity ? 999 : conflict.existingScore,
      event_cp_id: cpId,
      event_cp_name: cpName,
      event_has_guests: hasGuests,
      event_google_id: googleEventId,
      deal_context: dealContext,
      recommendation: conflict.recommendation,
      alt_slot_start: altSlotStart,
      alt_slot_end: altSlotEnd,
      new_event_score: conflict.newScore,
    })
  }

  return enriched
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

  // Enrich conflict data with CP name, deal context, alt slot, guest info
  let enrichedConflicts: ConflictCardData[] | undefined
  if (holdResult.conflicts && holdResult.conflicts.length > 0) {
    try {
      enrichedConflicts = await enrichConflictData(
        action.user_id,
        holdResult.conflicts,
        settings
      )
    } catch (enrichError) {
      console.error('[optimizer] Conflict enrichment failed, using minimal data:', enrichError)
      // Fallback: minimal conflict data (same as before)
      enrichedConflicts = holdResult.conflicts.map(c => ({
        event_id: c.existingEvent.id,
        event_title: c.existingEvent.title || 'Calendar event',
        event_start: c.existingEvent.start_time,
        event_end: c.existingEvent.end_time,
        event_weight: c.existingEvent.weight ?? 7,
        event_score: c.existingScore === Infinity ? 999 : c.existingScore,
        event_cp_id: null,
        event_cp_name: null,
        event_has_guests: false,
        event_google_id: (c.existingEvent as Record<string, unknown>).google_event_id as string | null || null,
        deal_context: null,
        recommendation: c.recommendation,
        alt_slot_start: null,
        alt_slot_end: null,
        new_event_score: c.newScore,
      }))
    }
  }

  const conflicts = holdResult.conflicts?.map(c => ({
    name: c.existingEvent.title || 'existing event',
    recommendation: c.recommendation,
  }))

  // CRITICAL: Persist hold data to DB FIRST, before the AI call.
  // If the Vercel timeout kills us during generateSchedulingIntent,
  // the action card still has hold_event_id, location, start, end.
  const holdPayload = {
    ...payload,
    hold_event_id: hold.id,
    gcal_event_id: holdResult.gcalEventId || null,
    start: hold.start_time,
    end: hold.end_time,
    location: meetingLocation || null,
    is_online: false,
    meeting_type: (payload.meeting_type as string) || 'address',
    conflicts: enrichedConflicts,
  }

  // Persist hold data + original intent to DB FIRST (safety against timeout).
  // Slot time is rendered by the email template from payload.start/end — NOT in intent_cs.
  await updateAction(action.id, {
    intent_cs: action.intent_cs || '',
    payload: holdPayload,
  })

  // Now try to rewrite intent_cs via mila-voice — optional beautification.
  // If this times out, the hold data and original intent are already persisted above.
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
    const intentCs = voiceResult.intent_cs

    await updateAction(action.id, {
      intent_cs: intentCs,
      payload: holdPayload,
    })
  } catch (voiceError) {
    console.error('[optimizer] generateSchedulingIntent failed, fallback intent already persisted:', voiceError)
    // No action needed — original intent + holdPayload already written above
  }
}

/**
 * Parse an ISO 8601 string into a Date, assuming Prague local time for naive strings.
 * Handles both timezone-aware ("...Z", "...+02:00") and naive ("2026-03-24T10:00:00") formats.
 * Returns undefined if parsing fails or the date is in the past.
 */
function parseTimePreferenceToPragueDate(isoString: string): Date | undefined {
  try {
    let parsed: Date
    if (isoString.includes('Z') || /[+-]\d{2}:\d{2}$/.test(isoString)) {
      parsed = new Date(isoString)
    } else {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Prague',
        timeZoneName: 'shortOffset',
      })
      const parts = formatter.formatToParts(new Date())
      const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || ''
      const offsetMatch = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
      let offsetStr = '+01:00'
      if (offsetMatch) {
        const sign = offsetMatch[1]
        const hours = offsetMatch[2].padStart(2, '0')
        const minutes = (offsetMatch[3] || '0').padStart(2, '0')
        offsetStr = `${sign}${hours}:${minutes}`
      }
      parsed = new Date(`${isoString}${offsetStr}`)
    }
    if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now() - 86400000) {
      return parsed
    }
  } catch {
    // Invalid date — ignore
  }
  return undefined
}

/**
 * Score slots against structured time preferences.
 * Returns slots with score > 0 sorted descending by score.
 * Falls back to returning all slots if nothing scores > 0.
 */
function scoreSlotsAgainstPreferences(
  slots: SlotProposal[],
  preferences: TimePreference[]
): SlotProposal[] {
  if (preferences.length === 0 || slots.length === 0) return slots

  const scored: { slot: SlotProposal; score: number }[] = slots.map(slot => {
    let totalScore = 0

    for (const pref of preferences) {
      const prefDate = parseTimePreferenceToPragueDate(pref.time)
      if (!prefDate) continue

      const rankWeight = pref.rank === 1 ? 1.0 : pref.rank === 2 ? 0.7 : 0.5
      let prefScore = 0

      if (pref.flexibility === 'exact') {
        // Match if slot start hour and minute match exactly
        const diffMs = Math.abs(slot.start.getTime() - prefDate.getTime())
        prefScore = diffMs === 0 ? 10 : 0
      } else if (pref.flexibility === 'approximate') {
        // ±60min window, linear decay
        const diffMinutes = Math.abs(slot.start.getTime() - prefDate.getTime()) / 60000
        prefScore = Math.max(0, 10 - (diffMinutes / 6))
      } else if (pref.flexibility === 'loose') {
        // Same half-day = 10, same day = 5, else 0
        const sameDay = slot.start.toDateString() === prefDate.toDateString()
        if (sameDay) {
          const slotIsAM = slot.start.getHours() < 12
          const prefIsAM = prefDate.getHours() < 12
          prefScore = slotIsAM === prefIsAM ? 10 : 5
        }
      }

      totalScore += prefScore * rankWeight
    }

    return { slot, score: totalScore }
  })

  const withScore = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)
  return withScore.length > 0 ? withScore.map(s => s.slot) : slots
}

/**
 * LLM escape hatch: when timePreferences is empty but cpAvailabilityRaw has text,
 * ask a cheap LLM to score slots against the raw CP text.
 * Falls back to returning all slots on failure.
 */
async function llmEscapeHatchScoring(
  slots: SlotProposal[],
  cpAvailabilityRaw: string
): Promise<SlotProposal[]> {
  if (slots.length === 0) return slots

  const slotDescriptions = slots.map((s, i) =>
    `${i}: ${s.start.toISOString()} — ${s.end.toISOString()}`
  ).join('\n')

  const prompt = `CP said: "${cpAvailabilityRaw}"

Available slots:
${slotDescriptions}

Score each slot 0-10 for how well it matches CP's stated availability.
Return ONLY a JSON array of numbers (one score per slot, same order).
Example: [8, 2, 0, 10]`

  try {
    const result = await runAITask('filter', prompt)
    const match = result.match(/\[[\s\S]*?\]/)
    if (!match) return slots

    const scores: number[] = JSON.parse(match[0])
    if (!Array.isArray(scores) || scores.length !== slots.length) return slots

    const scored = slots
      .map((slot, i) => ({ slot, score: scores[i] || 0 }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    return scored.length > 0 ? scored.map(s => s.slot) : slots
  } catch (error) {
    console.error('[scheduling] LLM escape hatch failed, using all slots:', error)
    return slots
  }
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
