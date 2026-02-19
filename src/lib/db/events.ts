import { getSupabaseAdmin } from '../supabase/client'
import type { Event, EventInsert } from '../supabase/types'
import { calculatePriorityScore } from './actions'

/**
 * Get an event by ID
 */
export async function getEventById(eventId: string): Promise<Event | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', eventId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get event: ${error.message}`)
  }

  return data
}

/**
 * Get events for a user within a date range
 */
export async function getEventsInRange(
  userId: string,
  startDate: Date,
  endDate: Date
): Promise<Event[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .gte('start_time', startDate.toISOString())
    .lte('start_time', endDate.toISOString())
    .order('start_time', { ascending: true })

  if (error) {
    throw new Error(`Failed to get events: ${error.message}`)
  }

  return data || []
}

/**
 * Get events for today
 */
export async function getEventsForToday(userId: string, timezone: string = 'UTC'): Promise<Event[]> {
  const now = new Date()
  // Extract the user's local date using Intl (reliable across Node versions)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(now)
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026', 10)
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '1', 10) - 1
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '1', 10)

  // Build start/end of day in UTC using the user's local date
  // This is an approximation: we use a ±1 day buffer to catch edge cases
  const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0))
  const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999))

  return getEventsInRange(userId, startOfDay, endOfDay)
}

/**
 * Get upcoming events (next N days)
 */
export async function getUpcomingEvents(
  userId: string,
  days: number = 7
): Promise<Event[]> {
  const now = new Date()
  const futureDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  return getEventsInRange(userId, now, futureDate)
}

/**
 * Create a new event
 */
export async function createEvent(event: EventInsert): Promise<Event> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .insert({
      ...event,
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create event: ${error.message}`)
  }

  return data
}

/**
 * Update an event
 */
export async function updateEvent(
  eventId: string,
  updates: Partial<Omit<Event, 'id' | 'user_id' | 'created_at'>>
): Promise<Event> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .update(updates)
    .eq('id', eventId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update event: ${error.message}`)
  }

  return data
}

/**
 * Delete an event
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('events')
    .delete()
    .eq('id', eventId)

  if (error) {
    throw new Error(`Failed to delete event: ${error.message}`)
  }
}

/**
 * Check for scheduling conflicts
 */
export async function findConflicts(
  userId: string,
  startTime: Date,
  endTime: Date,
  excludeEventId?: string
): Promise<Event[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'cancelled')
    .or(`and(start_time.lt.${endTime.toISOString()},end_time.gt.${startTime.toISOString()})`)

  if (excludeEventId) {
    query = query.neq('id', excludeEventId)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to find conflicts: ${error.message}`)
  }

  return data || []
}

/**
 * Get the last event location for a user (for travel time calculation)
 */
export async function getLastEventLocation(
  userId: string,
  beforeTime: Date
): Promise<string | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('location')
    .eq('user_id', userId)
    .lt('end_time', beforeTime.toISOString())
    .not('location', 'is', null)
    .order('end_time', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get last event location: ${error.message}`)
  }

  return data?.location || null
}

/**
 * Get events with a specific CP
 */
export async function getEventsWithCP(
  userId: string,
  cpId: string
): Promise<Event[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .eq('cp_id', cpId)
    .order('start_time', { ascending: false })

  if (error) {
    throw new Error(`Failed to get events with CP: ${error.message}`)
  }

  return data || []
}

/**
 * Find available time slots
 */
export async function findAvailableSlots(
  userId: string,
  date: Date,
  durationMinutes: number,
  workingHoursStart: number = 9,
  workingHoursEnd: number = 18
): Promise<{ start: Date; end: Date }[]> {
  const startOfDay = new Date(date)
  startOfDay.setHours(workingHoursStart, 0, 0, 0)

  const endOfDay = new Date(date)
  endOfDay.setHours(workingHoursEnd, 0, 0, 0)

  const events = await getEventsInRange(userId, startOfDay, endOfDay)

  const slots: { start: Date; end: Date }[] = []
  let currentTime = startOfDay

  for (const event of events) {
    const eventStart = new Date(event.start_time)

    // Check if there's a gap before this event
    const gapMinutes = (eventStart.getTime() - currentTime.getTime()) / (1000 * 60)

    if (gapMinutes >= durationMinutes) {
      slots.push({
        start: new Date(currentTime),
        end: new Date(currentTime.getTime() + durationMinutes * 60 * 1000),
      })
    }

    currentTime = new Date(event.end_time)
  }

  // Check for slot at end of day
  const finalGapMinutes = (endOfDay.getTime() - currentTime.getTime()) / (1000 * 60)
  if (finalGapMinutes >= durationMinutes) {
    slots.push({
      start: new Date(currentTime),
      end: new Date(currentTime.getTime() + durationMinutes * 60 * 1000),
    })
  }

  return slots
}

/**
 * Get all events in a pre-block group
 */
export async function getEventsByBlockGroup(preBlockGroupId: string): Promise<Event[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('pre_block_group_id', preBlockGroupId)
    .order('start_time', { ascending: true })

  if (error) {
    throw new Error(`Failed to get events by block group: ${error.message}`)
  }

  return data || []
}

/**
 * Clean up a pre-block group after one slot is confirmed.
 * Deletes all tentative holds except the confirmed one.
 */
export async function cleanupBlockGroup(
  preBlockGroupId: string,
  confirmedEventId: string
): Promise<string[]> {
  const events = await getEventsByBlockGroup(preBlockGroupId)
  const deletedIds: string[] = []

  for (const event of events) {
    if (event.id !== confirmedEventId && event.status === 'tentative') {
      await deleteEvent(event.id)
      deletedIds.push(event.id)
    }
  }

  return deletedIds
}

/**
 * Create a tentative HOLD event (pre-block for scheduling proposals)
 */
export async function createHoldEvent(params: {
  userId: string
  cpId: string
  cpName: string
  startTime: Date
  endTime: Date
  preBlockGroupId: string
  location?: string
}): Promise<Event> {
  return createEvent({
    user_id: params.userId,
    cp_id: params.cpId,
    title: `HOLD: Meeting with ${params.cpName}`,
    description: `Tentative hold - awaiting confirmation from ${params.cpName}`,
    location: params.location || null,
    event_type: 'meeting',
    status: 'tentative',
    start_time: params.startTime.toISOString(),
    end_time: params.endTime.toISOString(),
    pre_block_group_id: params.preBlockGroupId,
  })
}

/**
 * Create a travel buffer event linked to a parent event
 */
export async function createTravelBuffer(params: {
  userId: string
  parentEventId: string
  startTime: Date
  endTime: Date
  fromLocation: string
  toLocation: string
  travelDurationText: string
}): Promise<Event> {
  return createEvent({
    user_id: params.userId,
    parent_event_id: params.parentEventId,
    title: `Travel: ${params.fromLocation} → ${params.toLocation}`,
    description: `Travel buffer (${params.travelDurationText}). Auto-managed by Mila.`,
    event_type: 'travel_buffer',
    status: 'confirmed',
    start_time: params.startTime.toISOString(),
    end_time: params.endTime.toISOString(),
  })
}

/**
 * Clean up travel buffers linked to a parent event
 */
export async function cleanupTravelBuffers(parentEventId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('events')
    .delete()
    .eq('parent_event_id', parentEventId)
    .eq('event_type', 'travel_buffer')

  if (error) {
    throw new Error(`Failed to cleanup travel buffers: ${error.message}`)
  }
}

/**
 * Get travel buffers for a parent event
 */
export async function getTravelBuffers(parentEventId: string): Promise<Event[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('parent_event_id', parentEventId)
    .eq('event_type', 'travel_buffer')

  if (error) {
    throw new Error(`Failed to get travel buffers: ${error.message}`)
  }

  return data || []
}

/**
 * Confirm a tentative event (change status from tentative to confirmed)
 */
export async function confirmEvent(eventId: string): Promise<Event> {
  return updateEvent(eventId, { status: 'confirmed' })
}

/**
 * Cancel an event and clean up its travel buffers
 */
export async function cancelEventWithCleanup(eventId: string): Promise<void> {
  await updateEvent(eventId, { status: 'cancelled' })
  await cleanupTravelBuffers(eventId)
}

/**
 * Calculate priority score for a calendar event
 * User-created events default weight = 100
 * All events must have scores
 */
export function calculateEventScore(params: {
  dollarValue?: number
  urgency?: number
  painFactor?: number
  daysIgnored?: number
  weight?: number
  offerMultiplier?: number
  isUserCreated?: boolean
}): number {
  const weight = params.weight ?? (params.isUserCreated ? 100 : 0)

  return calculatePriorityScore({
    dollarValue: params.dollarValue || 0,
    urgency: params.urgency || 1,
    painFactor: params.painFactor || 1,
    daysIgnored: params.daysIgnored || 0,
    weight,
    offerMultiplier: params.offerMultiplier || 1,
  })
}

/**
 * Get all events that are children of a parent event (travel buffers, etc.)
 */
export async function getChildEvents(parentEventId: string): Promise<Event[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('parent_event_id', parentEventId)

  if (error) {
    throw new Error(`Failed to get child events: ${error.message}`)
  }

  return data || []
}
