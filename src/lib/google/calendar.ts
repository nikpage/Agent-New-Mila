import { google, calendar_v3 } from 'googleapis'
import { getAuthenticatedClient } from './auth'

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  location?: string
  startTime: Date
  endTime: Date
  attendees?: { email: string; name?: string; responseStatus?: string }[]
  organizer?: { email: string; name?: string }
  status: string
  htmlLink?: string
}

export interface CreateEventParams {
  summary: string
  description?: string
  location?: string
  startTime: Date
  endTime: Date
  attendees?: string[]
  sendUpdates?: 'all' | 'externalOnly' | 'none'
}

/**
 * Get Calendar API client for a user
 */
async function getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
  const auth = await getAuthenticatedClient(userId)
  return google.calendar({ version: 'v3', auth })
}

/**
 * Get upcoming events
 */
export async function getUpcomingCalendarEvents(
  userId: string,
  options?: {
    maxResults?: number
    timeMin?: Date
    timeMax?: Date
  }
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId)

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: (options?.timeMin || new Date()).toISOString(),
    timeMax: options?.timeMax?.toISOString(),
    maxResults: options?.maxResults || 50,
    singleEvents: true,
    orderBy: 'startTime',
  })

  return (response.data.items || []).map(parseCalendarEvent).filter((e): e is CalendarEvent => e !== null)
}

/**
 * Get events for a specific day
 */
export async function getEventsForDay(
  userId: string,
  date: Date,
  timezone: string = 'UTC'
): Promise<CalendarEvent[]> {
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)

  const endOfDay = new Date(date)
  endOfDay.setHours(23, 59, 59, 999)

  return getUpcomingCalendarEvents(userId, {
    timeMin: startOfDay,
    timeMax: endOfDay,
  })
}

/**
 * Parse a Google Calendar event
 */
function parseCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!event.id) return null

  const startTime = event.start?.dateTime
    ? new Date(event.start.dateTime)
    : event.start?.date
      ? new Date(event.start.date)
      : null

  const endTime = event.end?.dateTime
    ? new Date(event.end.dateTime)
    : event.end?.date
      ? new Date(event.end.date)
      : null

  if (!startTime || !endTime) return null

  return {
    id: event.id,
    summary: event.summary || 'Untitled',
    description: event.description || undefined,
    location: event.location || undefined,
    startTime,
    endTime,
    attendees: event.attendees?.map(a => ({
      email: a.email || '',
      name: a.displayName || undefined,
      responseStatus: a.responseStatus || undefined,
    })),
    organizer: event.organizer
      ? {
          email: event.organizer.email || '',
          name: event.organizer.displayName || undefined,
        }
      : undefined,
    status: event.status || 'confirmed',
    htmlLink: event.htmlLink || undefined,
  }
}

/**
 * Create a new calendar event
 */
export async function createCalendarEvent(
  userId: string,
  params: CreateEventParams
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(userId)

  const response = await calendar.events.insert({
    calendarId: 'primary',
    sendUpdates: params.sendUpdates || 'all',
    requestBody: {
      summary: params.summary,
      description: params.description,
      location: params.location,
      start: {
        dateTime: params.startTime.toISOString(),
      },
      end: {
        dateTime: params.endTime.toISOString(),
      },
      attendees: params.attendees?.map(email => ({ email })),
    },
  })

  const parsed = parseCalendarEvent(response.data)
  if (!parsed) {
    throw new Error('Failed to parse created event')
  }

  return parsed
}

/**
 * Update a calendar event
 */
export async function updateCalendarEvent(
  userId: string,
  eventId: string,
  updates: Partial<CreateEventParams>
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(userId)

  const requestBody: calendar_v3.Schema$Event = {}

  if (updates.summary !== undefined) requestBody.summary = updates.summary
  if (updates.description !== undefined) requestBody.description = updates.description
  if (updates.location !== undefined) requestBody.location = updates.location
  if (updates.startTime !== undefined) {
    requestBody.start = { dateTime: updates.startTime.toISOString() }
  }
  if (updates.endTime !== undefined) {
    requestBody.end = { dateTime: updates.endTime.toISOString() }
  }
  if (updates.attendees !== undefined) {
    requestBody.attendees = updates.attendees.map(email => ({ email }))
  }

  const response = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: updates.sendUpdates || 'all',
    requestBody,
  })

  const parsed = parseCalendarEvent(response.data)
  if (!parsed) {
    throw new Error('Failed to parse updated event')
  }

  return parsed
}

/**
 * Delete a calendar event
 */
export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  sendUpdates: 'all' | 'externalOnly' | 'none' = 'all'
): Promise<void> {
  const calendar = await getCalendarClient(userId)

  await calendar.events.delete({
    calendarId: 'primary',
    eventId,
    sendUpdates,
  })
}

/**
 * Check for conflicts with existing events
 */
export async function checkConflicts(
  userId: string,
  startTime: Date,
  endTime: Date
): Promise<CalendarEvent[]> {
  const events = await getUpcomingCalendarEvents(userId, {
    timeMin: startTime,
    timeMax: endTime,
  })

  // Filter to events that actually overlap
  return events.filter(event => {
    return event.startTime < endTime && event.endTime > startTime
  })
}

/**
 * Find free slots on a given day
 */
export async function findFreeSlots(
  userId: string,
  date: Date,
  durationMinutes: number,
  workingHoursStart: number = 9,
  workingHoursEnd: number = 18
): Promise<{ start: Date; end: Date }[]> {
  const events = await getEventsForDay(userId, date)

  const startOfDay = new Date(date)
  startOfDay.setHours(workingHoursStart, 0, 0, 0)

  const endOfDay = new Date(date)
  endOfDay.setHours(workingHoursEnd, 0, 0, 0)

  const slots: { start: Date; end: Date }[] = []
  let currentTime = startOfDay

  // Sort events by start time
  const sortedEvents = events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

  for (const event of sortedEvents) {
    // Check if there's a gap before this event
    const gapMinutes = (event.startTime.getTime() - currentTime.getTime()) / (1000 * 60)

    if (gapMinutes >= durationMinutes) {
      slots.push({
        start: new Date(currentTime),
        end: new Date(currentTime.getTime() + durationMinutes * 60 * 1000),
      })
    }

    // Move current time to end of this event
    if (event.endTime > currentTime) {
      currentTime = event.endTime
    }
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
 * Respond to a calendar invitation
 */
export async function respondToInvitation(
  userId: string,
  eventId: string,
  response: 'accepted' | 'declined' | 'tentative'
): Promise<void> {
  const calendar = await getCalendarClient(userId)

  // Get the event first to get attendee list
  const event = await calendar.events.get({
    calendarId: 'primary',
    eventId,
  })

  // This is a simplified version - full implementation would need to
  // update the attendee status through the API
  console.log(`Responding ${response} to event ${eventId}`)
}
