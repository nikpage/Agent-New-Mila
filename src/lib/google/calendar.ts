import { google, calendar_v3 } from 'googleapis'
import { getAuthenticatedClient } from './auth'
import { isSameGmailAddress } from '@/lib/db/counterparties'

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
  /** Private extended properties — only readable by this app */
  extendedProperties?: Record<string, string>
}

/**
 * Key used in extendedProperties.private to mark events created by Mila.
 * Allows calendar ingestion to recognize and skip Mila-managed events
 * even after a DB wipe (the Google Calendar event survives).
 */
export const MILA_MANAGED_KEY = 'milaManaged'
export const MILA_BLOCK_GROUP_KEY = 'milaBlockGroupId'

export interface CreateEventParams {
  summary: string
  description?: string
  location?: string
  startTime: Date
  endTime: Date
  attendees?: string[]
  sendUpdates?: 'all' | 'externalOnly' | 'none'
  /** Private extended properties to tag on the GCal event */
  privateExtendedProperties?: Record<string, string>
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
    extendedProperties: event.extendedProperties?.private
      ? Object.fromEntries(Object.entries(event.extendedProperties.private))
      : undefined,
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
      extendedProperties: {
        private: {
          [MILA_MANAGED_KEY]: 'true',
          ...params.privateExtendedProperties,
        },
      },
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
  workingHoursEnd: number = 18,
  bufferMinutes: number = 0
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

    // Move current time to end of this event + buffer
    const eventEndWithBuffer = new Date(event.endTime.getTime() + bufferMinutes * 60 * 1000)
    if (eventEndWithBuffer > currentTime) {
      currentTime = eventEndWithBuffer
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
  response: 'accepted' | 'declined' | 'tentative',
  userEmail: string
): Promise<void> {
  const calendar = await getCalendarClient(userId)

  // Get the event to find the attendee entry
  const event = await calendar.events.get({
    calendarId: 'primary',
    eventId,
  })

  if (!event.data.attendees) {
    console.log(`No attendees found on event ${eventId}, cannot respond`)
    return
  }

  // Update the user's attendee status
  const updatedAttendees = event.data.attendees.map(attendee => {
    if ((attendee.email && isSameGmailAddress(attendee.email, userEmail)) || attendee.self) {
      return { ...attendee, responseStatus: response }
    }
    return attendee
  })

  await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: 'all',
    requestBody: {
      attendees: updatedAttendees,
    },
  })
}

/**
 * Get pending calendar invitations (events where user hasn't responded)
 */
export async function getPendingInvitations(
  userId: string,
  userEmail: string
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId)

  const now = new Date()
  const futureDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 days ahead

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: futureDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  })

  const events = (response.data.items || [])
    .map(parseCalendarEvent)
    .filter((e): e is CalendarEvent => e !== null)

  // Filter to events where user is an attendee with needsAction status
  return events.filter(event => {
    if (!event.attendees) return false
    return event.attendees.some(
      a => (a.email != null && isSameGmailAddress(a.email, userEmail)) &&
           a.responseStatus === 'needsAction'
    )
  })
}

/**
 * Create a tentative/HOLD calendar event (not sending invites to attendees)
 */
export async function createTentativeCalendarEvent(
  userId: string,
  params: CreateEventParams & { status?: 'tentative' | 'confirmed' }
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(userId)

  const response = await calendar.events.insert({
    calendarId: 'primary',
    sendUpdates: 'none', // Don't notify anyone for holds
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
      status: params.status || 'tentative',
      transparency: 'opaque', // Show as busy
      extendedProperties: {
        private: {
          [MILA_MANAGED_KEY]: 'true',
          ...params.privateExtendedProperties,
        },
      },
    },
  })

  const parsed = parseCalendarEvent(response.data)
  if (!parsed) {
    throw new Error('Failed to parse created tentative event')
  }

  return parsed
}

/**
 * Confirm a tentative event and optionally add attendees + send invites
 */
export async function confirmCalendarEvent(
  userId: string,
  eventId: string,
  attendees?: string[],
  updates?: {
    summary?: string
    location?: string
    description?: string
  }
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(userId)

  const requestBody: calendar_v3.Schema$Event = {
    status: 'confirmed',
    ...updates,
  }

  if (attendees && attendees.length > 0) {
    requestBody.attendees = attendees.map(email => ({ email }))
  }

  const response = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: attendees ? 'all' : 'none',
    requestBody,
  })

  const parsed = parseCalendarEvent(response.data)
  if (!parsed) {
    throw new Error('Failed to parse confirmed event')
  }

  return parsed
}

/**
 * Check if a Google Calendar event is an incoming invitation
 */
export function isIncomingInvitation(
  event: CalendarEvent,
  userEmail: string
): boolean {
  // Event is an invitation if the organizer is not the user
  // and the user is in the attendees list
  if (!event.organizer || !event.attendees) return false

  const organizerIsUser = event.organizer.email != null && isSameGmailAddress(event.organizer.email, userEmail)
  if (organizerIsUser) return false

  const userIsAttendee = event.attendees.some(
    a => a.email != null && isSameGmailAddress(a.email, userEmail)
  )

  return userIsAttendee
}
