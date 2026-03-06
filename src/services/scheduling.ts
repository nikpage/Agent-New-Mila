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
import { calculatePriorityScore, getPendingScheduleActions } from '@/lib/db/actions'
import { getTravelTime, calculateDepartureTime } from '@/lib/google/maps'
import { isWorkingDay, getNextWorkingDay } from '@/lib/holidays'
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
  newTitle?: string
): Promise<{ event: Event; travelBuffer?: Event }> {
  let confirmedEvent = await confirmEvent(confirmedEventId)

  if (newTitle) {
    confirmedEvent = await updateEvent(confirmedEventId, { title: newTitle })
  }

  // Confirm on Google Calendar + send invite to CP
  if (confirmedEvent.google_event_id) {
    try {
      await confirmCalendarEvent(
        userId,
        confirmedEvent.google_event_id,
        cpEmail ? [cpEmail] : undefined,
        {
          summary: newTitle || confirmedEvent.title || 'Meeting',
          location: location || confirmedEvent.location || undefined,
        }
      )
    } catch (error) {
      console.error('Failed to confirm gcal event:', error)
    }
  } else if (cpEmail) {
    try {
      const gcalEvent = await createCalendarEvent(userId, {
        summary: confirmedEvent.title || 'Meeting',
        description: confirmedEvent.description || undefined,
        location: location || confirmedEvent.location || undefined,
        startTime: new Date(confirmedEvent.start_time),
        endTime: new Date(confirmedEvent.end_time),
        attendees: [cpEmail],
        sendUpdates: 'all',
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

  // Find candidate slots (more than needed so we can pick the best conflict-free one)
  const slots = await findBestSlots(userId, duration, 10, preferredDate, location)

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

  // Get all free slots for the next 14 days (enough to schedule all meetings)
  const allSlots = await findBestSlots(userId, settings.default_meeting_duration, 50)

  // Track which slots we've consumed (each hold blocks a slot)
  const usedSlotTimes = new Set<string>()

  // Sort actions by priority so highest-priority meetings get first pick
  const sortedActions = [...actions].sort(
    (a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0)
  )

  for (const action of sortedActions) {
    const payload = action.payload as Record<string, unknown> | null
    const cpAvailability = (payload?.cp_availability as string) || null
    const meetingLocation = (payload?.location as string) || null

    // Filter available slots (not yet consumed by earlier meetings in this batch)
    const availableSlots = allSlots.filter(
      s => !usedSlotTimes.has(s.start.toISOString())
    )

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
        userId, candidateSlots, meetingLocation, usedSlotTimes, settings
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
          settings.default_meeting_duration,
          meetingLocation || undefined
        )
        if (holdResult.success && holdResult.holdEvent) {
          result.optimized++
          result.holds.push(holdResult.holdEvent)
          usedSlotTimes.add(slot.start.toISOString())
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
            settings.default_meeting_duration,
            meetingLocation || undefined
          )
          if (holdResult.success && holdResult.holdEvent) {
            result.optimized++
            result.holds.push(holdResult.holdEvent)
            usedSlotTimes.add(slot.start.toISOString())
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
  usedSlotTimes: Set<string>,
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
