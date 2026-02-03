import { getSupabaseAdmin } from '../supabase/client'
import type { Event, EventInsert } from '../supabase/types'

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
  const startOfDay = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  startOfDay.setHours(0, 0, 0, 0)

  const endOfDay = new Date(startOfDay)
  endOfDay.setHours(23, 59, 59, 999)

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
