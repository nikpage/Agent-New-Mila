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
import { calculatePriorityScore, getPendingScheduleActions, updateAction } from '@/lib/db/actions'
import { getTravelTime, calculateDepartureTime } from '@/lib/google/maps'
import { isWorkingDay, getNextWorkingDay } from '@/lib/holidays'
import { generateSchedulingIntent } from '@/lib/ai/mila-voice'
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
    result.push({
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
    } as Event)
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
  const conflicts = await findAllConflicts(userId, proposedStart, proposedEnd)
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

    // CP-stated time conflicts — book anyway, report conflict
    const holdResult = await blockSlotForProposal(userId, cpId, preferredSlot, duration, location)
    const slotConflicts = await findAllConflicts(userId, preferredDate, preferredEnd)

    if (slotConflicts.length > 0) {
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

    return holdResult
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
  // Actions with a specific suggestedTime get scheduled first so they claim
  // their constrained slot before flexible actions fill the gaps.
  const sortedActions = [...actions].sort((a, b) => {
    const payloadA = a.payload as Record<string, unknown> | null
    const payloadB = b.payload as Record<string, unknown> | null
    const timeA = (payloadA?.suggestedTime as string) || null
    const availA = (payloadA?.cp_availability as string) || null
    const timeB = (payloadB?.suggestedTime as string) || null
    const availB = (payloadB?.cp_availability as string) || null

    // Constraint score: specific time = 3, CP availability text = 2, none = 1
    const constraintA = timeA ? 3 : availA ? 2 : 1
    const constraintB = timeB ? 3 : availB ? 2 : 1

    if (constraintA !== constraintB) return constraintB - constraintA

    // Within same constraint level, break ties by urgency (higher first)
    return (b.urgency ?? 1) - (a.urgency ?? 1)
  })

  for (const action of sortedActions) {
    const payload = action.payload as Record<string, unknown> | null
    const cpAvailability = (payload?.cp_availability as string) || null
    const suggestedTime = (payload?.suggestedTime as string) || null
    const payloadMeetingType = (payload?.meeting_type as string) || 'address'
    // Phone and online meetings don't need a physical location — skip travel buffer
    const meetingLocation = (payloadMeetingType === 'phone' || payloadMeetingType === 'online')
      ? null
      : (payload?.suggestedLocation as string) || (payload?.location as string) || null
    const duration = (payload?.duration as number) || settings.default_meeting_duration

    // If CP stated a specific time, parse it as Prague local time.
    // Without timezone info, new Date() parses as UTC on Vercel,
    // causing e.g. 9:00 to become 10:00 in Prague.
    let preferredDate: Date | undefined
    if (suggestedTime) {
      try {
        let parsed: Date
        if (suggestedTime.includes('Z') || /[+-]\d{2}:\d{2}$/.test(suggestedTime)) {
          // Already has timezone — parse directly
          parsed = new Date(suggestedTime)
        } else {
          // No timezone — assume Prague local time.
          // Append Prague's real UTC offset so Date() parses correctly
          // regardless of server timezone (UTC on Vercel, Europe/Prague locally).
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Prague',
            timeZoneName: 'shortOffset',
          })
          const parts = formatter.formatToParts(new Date())
          const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || ''
          const offsetMatch = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
          let offsetStr = '+01:00' // fallback: CET
          if (offsetMatch) {
            const sign = offsetMatch[1]
            const hours = offsetMatch[2].padStart(2, '0')
            const minutes = (offsetMatch[3] || '0').padStart(2, '0')
            offsetStr = `${sign}${hours}:${minutes}`
          }
          // Append offset to naive string → "2026-03-20T09:00:00+01:00"
          // Date() now knows the intended timezone — works on any server.
          parsed = new Date(`${suggestedTime}${offsetStr}`)
        }
        if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now() - 86400000) {
          preferredDate = parsed
        }
      } catch {
        // Invalid date — ignore
      }
    }

    // ── Unified slot selection ──────────────────────────────────────
    // All slots — preferred or not — go through the same validation:
    // 1. Is it in allSlots (i.e. genuinely free on Google Calendar)?
    // 2. Is it available in this batch (not double-booked by earlier action)?
    // If a CP-stated time conflicts, we still book it but report the conflict.

    // Build candidate list. Preferred date gets checked against real GCal free slots.
    let candidateSlots: SlotProposal[] = []
    let preferredSlotIsFree = false

    if (preferredDate) {
      const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
      const preferredSlot: SlotProposal = { start: preferredDate, end: preferredEnd }

      // CP stated a specific time — respect it even if outside working hours/days.
      // If CP says "Saturday at 9 for the viewing", the user needs to know.
      // The action card surfaces the non-standard time; the user decides.
      {
        // Check if preferred time falls within a known free slot from Google Calendar.
        // allSlots are GCal-sourced with buffer — if the preferred time isn't in there,
        // it conflicts with something real on the calendar.
        preferredSlotIsFree = allSlots.some(free =>
          free.start.getTime() <= preferredDate!.getTime() &&
          free.end.getTime() >= preferredEnd.getTime()
        )

        // allSlots may not cover the preferred date's day (e.g. if it's today and
        // allSlots started from tomorrow). Fetch that day's free slots directly.
        if (!preferredSlotIsFree) {
          const daySlots = await findFreeSlots(
            userId, preferredDate, duration,
            settings.working_hours_start, settings.working_hours_end,
            settings.meeting_buffer_minutes
          )
          preferredSlotIsFree = daySlots.some(free =>
            free.start.getTime() <= preferredDate!.getTime() &&
            free.end.getTime() >= preferredEnd.getTime()
          )
        }

        if (preferredSlotIsFree && isSlotAvailable(preferredSlot)) {
          // Preferred time is genuinely free — use it directly
          const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined)
          if (holdResult.success && holdResult.holdEvent) {
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            bookedRanges.push(bookedRangeForHold(preferredDate, preferredEnd, holdResult))
            continue
          }
        } else if (isSlotAvailable(preferredSlot)) {
          // Preferred time conflicts with calendar — CP stated it, so book anyway
          // but report the conflict so the user knows.
          const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined)
          if (holdResult.success && holdResult.holdEvent) {
            // We don't have the specific conflicting event details from findFreeSlots,
            // but we know there IS a conflict because the slot isn't free.
            // Use findAllConflicts to get the details for reporting.
            const conflicts = await findAllConflicts(userId, preferredDate, preferredEnd)
            if (conflicts.length > 0) {
              const conflictInfos: ConflictInfo[] = conflicts.map(existing => {
                const isImmovable = existing.weight == null || existing.weight >= 100
                return {
                  existingEvent: existing,
                  existingScore: existing.weight != null ? calculateEventScore({ weight: existing.weight }) : Infinity,
                  newScore: action.priority_score ?? 0,
                  recommendation: isImmovable ? 'suggest_alternate' as const : 'move_existing' as const,
                }
              })
              holdResult.conflicts = conflictInfos
              for (const conflict of conflicts) {
                result.moveSuggestions.push({
                  existingEventId: conflict.id,
                  existingWeight: conflict.weight,
                  reason: `CP stated specific time: ${suggestedTime}`,
                })
              }
            }
            await updateActionWithHold(action, holdResult, meetingLocation, settings)
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            bookedRanges.push(bookedRangeForHold(preferredDate, preferredEnd, holdResult))
            continue
          }
        }
        // Preferred slot failed batch check (another action already booked it) —
        // fall through to normal slot selection below.
      }
    }

    // Normal path: pick from GCal-validated free slots
    const availableSlots = allSlots.filter(s => isSlotAvailable(s))

    if (availableSlots.length === 0) {
      result.unscheduled++
      continue
    }

    // Priority 1: Filter by CP availability if stated
    candidateSlots = availableSlots
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

    // All candidateSlots are already GCal-free. Pick the first batch-available one.
    let scheduled = false
    for (const slot of candidateSlots) {
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

  const cpAvailability = (payload?.cp_availability as string) || null
  const suggestedTime = (payload?.suggestedTime as string) || null
  const singleMeetingType = (payload?.meeting_type as string) || 'address'
  // Phone and online meetings don't need a physical location — skip travel buffer
  const meetingLocation = (singleMeetingType === 'phone' || singleMeetingType === 'online')
    ? null
    : (payload?.suggestedLocation as string) || (payload?.location as string) || null
  const duration = (payload?.duration as number) || settings.default_meeting_duration

  // Parse CP-stated time (same timezone logic as batch optimizer)
  let preferredDate: Date | undefined
  if (suggestedTime) {
    try {
      let parsed: Date
      if (suggestedTime.includes('Z') || /[+-]\d{2}:\d{2}$/.test(suggestedTime)) {
        parsed = new Date(suggestedTime)
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
        parsed = new Date(`${suggestedTime}${offsetStr}`)
      }
      if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now() - 86400000) {
        preferredDate = parsed
      }
    } catch {
      // Invalid date — ignore
    }
  }

  // CP stated a specific time — respect it even if outside working hours/days.
  // If CP says "Saturday at 9 for the viewing", the user needs to know.
  // The action card surfaces the non-standard time; the user decides.

  if (preferredDate) {
    const preferredEnd = new Date(preferredDate.getTime() + duration * 60 * 1000)
    const preferredSlot: SlotProposal = { start: preferredDate, end: preferredEnd }

    // Check against Google Calendar
    const daySlots = await findFreeSlots(
      userId, preferredDate, duration,
      settings.working_hours_start, settings.working_hours_end,
      settings.meeting_buffer_minutes
    )
    const preferredSlotIsFree = daySlots.some(free =>
      free.start.getTime() <= preferredDate!.getTime() &&
      free.end.getTime() >= preferredEnd.getTime()
    )

    if (preferredSlotIsFree) {
      const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined)
      if (holdResult.success && holdResult.holdEvent) {
        await updateActionWithHold(action, holdResult, meetingLocation, settings)
        result.optimized++
        result.holds.push(holdResult.holdEvent)
        return result
      }
    } else {
      // CP stated time conflicts — book anyway but report conflict
      const holdResult = await blockSlotForProposal(userId, action.cp_id, preferredSlot, duration, meetingLocation || undefined)
      if (holdResult.success && holdResult.holdEvent) {
        const conflicts = await findAllConflicts(userId, preferredDate, preferredEnd)
        if (conflicts.length > 0) {
          const conflictInfos: ConflictInfo[] = conflicts.map(existing => {
            const isImmovable = existing.weight == null || existing.weight >= 100
            return {
              existingEvent: existing,
              existingScore: existing.weight != null ? calculateEventScore({ weight: existing.weight }) : Infinity,
              newScore: action.priority_score ?? 0,
              recommendation: isImmovable ? 'suggest_alternate' as const : 'move_existing' as const,
            }
          })
          holdResult.conflicts = conflictInfos
          for (const conflict of conflicts) {
            result.moveSuggestions.push({
              existingEventId: conflict.id,
              existingWeight: conflict.weight,
              reason: `CP stated specific time: ${suggestedTime}`,
            })
          }
        }
        await updateActionWithHold(action, holdResult, meetingLocation, settings)
        result.optimized++
        result.holds.push(holdResult.holdEvent)
        return result
      }
    }
  }

  // No preferred time or it failed — find best free slot
  const allSlots = await findBestSlots(userId, duration, 20)
  let candidateSlots = allSlots

  if (cpAvailability) {
    const cpFiltered = filterSlotsByCpAvailability(allSlots, cpAvailability)
    if (cpFiltered.length > 0) {
      candidateSlots = cpFiltered
    }
  }

  if (meetingLocation && candidateSlots.length > 1) {
    candidateSlots = await rankSlotsByTravel(
      userId, candidateSlots, meetingLocation, [], settings
    )
  }

  for (const slot of candidateSlots) {
    const holdResult = await blockSlotForProposal(userId, action.cp_id, slot, duration, meetingLocation || undefined)
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
    conflicts: holdResult.conflicts?.map(c => ({
      event_id: c.existingEvent.id,
      event_title: c.existingEvent.title,
      recommendation: c.recommendation,
    })),
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
