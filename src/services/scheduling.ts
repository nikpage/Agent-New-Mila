/**
 * Core Scheduling Service
 * Handles all calendar scheduling logic for Mila
 *
 * Key responsibilities:
 * - Find best available slots considering working hours, holidays, travel
 * - Block multiple slots for proposals (pre-block groups)
 * - Handle conflicts using priority scoring
 * - Calculate and book travel buffers
 * - Clean up unused holds after confirmation
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
  cleanupBlockGroup,
  cleanupTravelBuffers,
  getEventsByBlockGroup,
  calculateEventScore,
  getLastEventLocation,
} from '@/lib/db/events'
import { getUserSettings } from '@/lib/db/users'
import { getUserById } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { calculatePriorityScore } from '@/lib/db/actions'
import { getTravelTime, calculateDepartureTime } from '@/lib/google/maps'
import { isWorkingDay, getNextWorkingDay } from '@/lib/holidays'
import type { UserSettings, Event } from '@/lib/supabase/types'
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
  preBlockGroupId?: string
  blockedSlots?: Event[]
  gcalEventIds?: string[]
  conflicts?: ConflictInfo[]
  error?: string
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

  const travelTime = await getTravelTime(
    origin,
    meetingLocation,
    settings.travel_mode
  )

  if (!travelTime) return null

  const travelMinutes = Math.ceil(travelTime.durationSeconds / 60)
  const travelBufferMinutes = Math.max(travelMinutes + 10, MIN_TRAVEL_BUFFER_MINUTES) // 10 min extra + minimum 15
  // Total = standard meeting buffer + travel buffer
  const bufferMinutes = settings.meeting_buffer_minutes + travelBufferMinutes

  const departureTime = new Date(slotStart.getTime() - bufferMinutes * 60 * 1000)

  return { bufferMinutes, departureTime }
}

/**
 * Block multiple time slots in user's calendar for a meeting proposal
 * Creates tentative HOLD events and returns the pre_block_group_id
 *
 * Flow:
 * 1. Block 3 slots in user calendar (titled "HOLD: Meeting with [CP]", status: tentative)
 * 2. Return the pre_block_group_id so we can send options to CP
 * 3. After CP confirms, call confirmSlot() to clean up unused holds
 */
export async function blockSlotsForProposal(
  userId: string,
  cpId: string,
  slots: SlotProposal[],
  durationMinutes: number,
  location?: string,
  weight?: number
): Promise<SchedulingResult> {
  const cp = await getCPById(cpId)
  if (!cp) {
    return { success: false, error: 'Counterparty not found' }
  }

  const cpName = cp.name || cp.primary_identifier
  const preBlockGroupId = uuidv4()
  const blockedSlots: Event[] = []
  const gcalEventIds: string[] = []

  // Localized title: "CP Name - REZERVACE"
  const holdTitle = `${cpName} - REZERVACE`

  for (const slot of slots) {
    try {
      // Create tentative event in Google Calendar (no notifications)
      // Tag with extendedProperties so Mila can recognize its own events
      // even after a DB wipe — prevents duplicate blocker events.
      const gcalEvent = await createTentativeCalendarEvent(userId, {
        summary: holdTitle,
        description: `Tentative hold - awaiting confirmation from ${cpName}. Managed by Mila.`,
        location: location,
        startTime: slot.start,
        endTime: slot.end,
        status: 'tentative',
        privateExtendedProperties: {
          [MILA_BLOCK_GROUP_KEY]: preBlockGroupId,
        },
      })

      gcalEventIds.push(gcalEvent.id)

      // Create local event record with block group — link to GCal event
      const localEvent = await createHoldEvent({
        userId,
        cpId,
        cpName,
        startTime: slot.start,
        endTime: slot.end,
        preBlockGroupId,
        location: location,
        googleEventId: gcalEvent.id,
        weight: weight ?? undefined,
      })

      blockedSlots.push(localEvent)
    } catch (error) {
      console.error(`Failed to block slot:`, error)
    }
  }

  if (blockedSlots.length === 0) {
    return { success: false, error: 'Failed to block any slots' }
  }

  return {
    success: true,
    preBlockGroupId,
    blockedSlots,
    gcalEventIds,
  }
}

/**
 * Confirm a specific slot from a pre-block group
 * Cleans up other tentative holds and books travel buffer
 */
export async function confirmSlot(
  userId: string,
  confirmedEventId: string,
  preBlockGroupId: string,
  cpEmail?: string,
  location?: string,
  newTitle?: string
): Promise<{ event: Event; travelBuffer?: Event }> {
  // Confirm the selected event in local DB
  let confirmedEvent = await confirmEvent(confirmedEventId)

  // Update title if provided
  if (newTitle) {
    confirmedEvent = await updateEvent(confirmedEventId, { title: newTitle })
  }

  // Clean up other tentative holds in the same group (local DB + collect GCal IDs)
  const { deletedGoogleEventIds } = await cleanupBlockGroup(preBlockGroupId, confirmedEventId)

  // Delete the orphaned Google Calendar holds
  for (const gcalId of deletedGoogleEventIds) {
    try {
      await deleteCalendarEvent(userId, gcalId, 'none')
    } catch (error) {
      console.error(`Failed to delete gcal hold ${gcalId}:`, error)
    }
  }

  // Confirm the chosen hold on Google Calendar (patch existing, don't create duplicate)
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
    // Fallback: no stored GCal ID — create a new confirmed event
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
      // Store the GCal ID for future reference
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

  const travelTime = await getTravelTime(origin, meetingLocation, settings.travel_mode)
  if (!travelTime) return null

  const travelMinutes = Math.ceil(travelTime.durationSeconds / 60)
  // Travel buffer = standard meeting buffer + actual travel time (+ 10 min padding, min 15 min travel)
  const travelBufferMinutes = Math.max(travelMinutes + 10, MIN_TRAVEL_BUFFER_MINUTES)
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
 * Full flow: find slots → block → create action for user approval
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

  // Step 1: Find best available slots
  const slots = await findBestSlots(userId, duration, 3, preferredDate, location)

  if (slots.length === 0) {
    return {
      success: false,
      error: 'No available slots found in the next 14 days',
    }
  }

  // Step 2: Check for conflicts with each proposed slot
  const validSlots: SlotProposal[] = []
  const conflicts: ConflictInfo[] = []

  for (const slot of slots) {
    const slotConflicts = await findConflicts(
      userId,
      slot.start,
      slot.end
    )

    if (slotConflicts.length === 0) {
      validSlots.push(slot)
    } else {
      // Check if we should propose moving the conflicting event
      const cp = await getCPById(cpId)
      const newScore = calculateEventScore({
        weight: 50,
        sellerMultiplier: cp?.role === 'seller' ? settings.offer_multiplier_seller : settings.offer_multiplier_buyer,
      })

      const slotConflictInfos = await handleConflict(
        userId,
        slot.start,
        slot.end,
        newScore,
        cpId
      )

      // If all conflicts recommend moving existing, we can still use this slot
      const allCanMove = slotConflictInfos.every(c => c.recommendation === 'move_existing')
      if (allCanMove) {
        validSlots.push(slot)
        conflicts.push(...slotConflictInfos)
      }
    }
  }

  if (validSlots.length === 0) {
    return {
      success: false,
      conflicts,
      error: 'All proposed slots have conflicts with higher-priority events',
    }
  }

  // Step 3: Block the valid slots
  const result = await blockSlotsForProposal(
    userId,
    cpId,
    validSlots.slice(0, 3), // Maximum 3 options
    duration,
    location
  )

  if (conflicts.length > 0) {
    result.conflicts = conflicts
  }

  return result
}

/**
 * For multiple CPs: send only 1 confirmed slot (not multiple options)
 * to avoid coordination hell
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

  // Find the single best slot that works
  const slots = await findBestSlots(userId, duration, 1, preferredDate, location)

  if (slots.length === 0) {
    return {
      success: false,
      error: 'No available slots found',
    }
  }

  const slot = slots[0]
  const preBlockGroupId = uuidv4()
  const blockedSlots: Event[] = []

  // Create a single hold event
  const cpNames = []
  for (const cpId of cpIds) {
    const cp = await getCPById(cpId)
    if (cp) {
      cpNames.push(cp.name || cp.primary_identifier)
    }
  }

  // Localized title: "CP1, CP2 - REZERVACE"
  const holdTitle = `${cpNames.join(', ')} - REZERVACE`

  try {
    await createTentativeCalendarEvent(userId, {
      summary: holdTitle,
      description: `Tentative hold - awaiting confirmation. Managed by Mila.`,
      location: location,
      startTime: slot.start,
      endTime: slot.end,
      status: 'tentative',
      privateExtendedProperties: {
        [MILA_BLOCK_GROUP_KEY]: preBlockGroupId,
      },
    })

    const localEvent = await createEvent({
      user_id: userId,
      cp_id: cpIds[0], // Primary CP
      title: holdTitle,
      description: `Meeting with: ${cpNames.join(', ')}`,
      location: location || null,
      event_type: 'meeting',
      status: 'tentative',
      start_time: slot.start.toISOString(),
      end_time: slot.end.toISOString(),
      pre_block_group_id: preBlockGroupId,
    })

    blockedSlots.push(localEvent)
  } catch (error) {
    console.error('Failed to block slot for multi-CP meeting:', error)
    return { success: false, error: 'Failed to block slot' }
  }

  return {
    success: true,
    preBlockGroupId,
    blockedSlots,
  }
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
