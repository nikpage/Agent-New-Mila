/**
 * Calendar Event Ingestion Service
 * Syncs Google Calendar events to local events table
 * Detects incoming invitations and creates action proposals
 */

import {
  getUpcomingCalendarEvents,
  getPendingInvitations,
  isIncomingInvitation,
  type CalendarEvent,
} from '@/lib/google/calendar'
import {
  createEvent,
  getEventsInRange,
  getEventById,
  updateEvent,
} from '@/lib/db/events'
import { calculateEventScore } from '@/lib/db/events'
import { getUserById } from '@/lib/db/users'
import { getUserSettings } from '@/lib/db/users'
import { getCPByIdentifier, findOrCreateCP, isSameGmailAddress } from '@/lib/db/counterparties'
import { createAction, hasPendingAction, calculatePriorityScore } from '@/lib/db/actions'
import { isPersonalEvent } from '@/config/client'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { v4 as uuidv4 } from 'uuid'

export interface CalendarIngestionResult {
  eventsSynced: number
  invitationsDetected: number
  actionsCreated: number
  errors: string[]
}

/**
 * Ingest calendar events for a user - sync Google Calendar to local events table
 */
export async function ingestCalendarEvents(
  userId: string
): Promise<CalendarIngestionResult> {
  const result: CalendarIngestionResult = {
    eventsSynced: 0,
    invitationsDetected: 0,
    actionsCreated: 0,
    errors: [],
  }

  try {
    const user = await getUserById(userId)
    if (!user) {
      result.errors.push('User not found')
      return result
    }

    const settings = await getUserSettings(userId)

    // Sync upcoming events from Google Calendar to local events table
    const now = new Date()
    const futureDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) // 14 days ahead

    const gcalEvents = await getUpcomingCalendarEvents(userId, {
      timeMin: now,
      timeMax: futureDate,
    })

    for (const gcalEvent of gcalEvents) {
      try {
        await syncGoogleEventToLocal(userId, gcalEvent, settings.timezone)
        result.eventsSynced++
      } catch (error) {
        result.errors.push(`Failed to sync event ${gcalEvent.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Detect pending invitations
    if (user.email) {
      try {
        const invitations = await getPendingInvitations(userId, user.email)
        result.invitationsDetected = invitations.length

        for (const invitation of invitations) {
          try {
            const actionCreated = await processInvitation(userId, user.email, invitation)
            if (actionCreated) {
              result.actionsCreated++
            }
          } catch (error) {
            result.errors.push(`Failed to process invitation ${invitation.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
          }
        }
      } catch (error) {
        result.errors.push(`Failed to fetch invitations: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }
  } catch (error) {
    result.errors.push(`Calendar ingestion error: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  return result
}

/**
 * Sync a Google Calendar event to the local events table
 */
async function syncGoogleEventToLocal(
  userId: string,
  gcalEvent: CalendarEvent,
  timezone: string
): Promise<void> {
  const supabase = getSupabaseAdmin()

  // Check if event already exists locally (by matching time range and title)
  const { data: existing } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .eq('start_time', gcalEvent.startTime.toISOString())
    .eq('end_time', gcalEvent.endTime.toISOString())
    .eq('title', gcalEvent.summary)
    .limit(1)

  if (existing && existing.length > 0) {
    // Event already synced, update status if changed
    await updateEvent(existing[0].id, {
      status: gcalEvent.status === 'cancelled' ? 'cancelled' : 'confirmed',
      location: gcalEvent.location || null,
      description: gcalEvent.description || null,
    })
    return
  }

  // Find CP from attendees (if any)
  let cpId: string | null = null
  if (gcalEvent.attendees && gcalEvent.attendees.length > 0) {
    // Find the first non-user attendee
    const user = await getUserById(userId)
    const userEmailLower = user?.email?.toLowerCase()

    // Only filter if we actually know the user's email — otherwise skip CP
    // creation entirely to avoid accidentally adding the user as their own CP.
    if (userEmailLower) {
      const otherAttendees = gcalEvent.attendees.filter(
        a => a.email && !isSameGmailAddress(a.email, user!.email!)
      )

      if (otherAttendees.length > 0) {
        const firstAttendee = otherAttendees[0]
        if (firstAttendee.email) {
          const cp = await findOrCreateCP(userId, firstAttendee.email, firstAttendee.name || undefined)
          if (cp) cpId = cp.id
        }
      }
    }
  }

  // Create local event record
  // User-created events get default weight = 100
  const isUserCreated = gcalEvent.organizer?.email?.toLowerCase() === (await getUserById(userId))?.email?.toLowerCase()
  const score = calculateEventScore({
    weight: isUserCreated ? 100 : 50,
    isUserCreated,
  })

  await createEvent({
    user_id: userId,
    cp_id: cpId,
    title: gcalEvent.summary,
    description: gcalEvent.description || null,
    location: gcalEvent.location || null,
    event_type: 'meeting',
    status: gcalEvent.status === 'cancelled' ? 'cancelled' : 'confirmed',
    start_time: gcalEvent.startTime.toISOString(),
    end_time: gcalEvent.endTime.toISOString(),
  })
}

/**
 * Process an incoming calendar invitation
 * Creates a SCHEDULE action proposal for user review
 */
async function processInvitation(
  userId: string,
  userEmail: string,
  invitation: CalendarEvent
): Promise<boolean> {
  if (!invitation.organizer?.email) return false

  // Personal events block time but don't generate action proposals
  if (isPersonalEvent(invitation.summary || '')) return false

  // Guard: skip if organizer is the user (self-organized events can appear as
  // pending invitations due to Google Calendar quirks with shared calendars,
  // resource rooms, etc.)
  if (isSameGmailAddress(invitation.organizer.email, userEmail)) {
    return false
  }

  // Double-check with the full isIncomingInvitation check
  if (!isIncomingInvitation(invitation, userEmail)) {
    return false
  }

  // Find or create CP for the organizer (null = user's own email, skip)
  const cp = await findOrCreateCP(
    userId,
    invitation.organizer.email,
    invitation.organizer.name || undefined
  )
  if (!cp) return false

  // Check if we already have a pending action for this invitation
  // Use a synthetic conversation ID based on the calendar event
  const syntheticConversationId = `cal-invite-${invitation.id}`

  const supabase = getSupabaseAdmin()
  const { count } = await supabase
    .from('action_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('cp_id', cp.id)
    .eq('action_type', 'SCHEDULE')
    .eq('status', 'pending')

  if ((count || 0) > 0) return false

  // We need a conversation_id - check if there's an existing conversation with this CP
  const { data: existingConv } = await supabase
    .from('conversation_threads')
    .select('id')
    .eq('user_id', userId)
    .limit(1)

  // If no conversation exists, we need to create a minimal one for the action
  let conversationId: string
  if (existingConv && existingConv.length > 0) {
    conversationId = existingConv[0].id
  } else {
    // Create a minimal conversation thread for this calendar invite
    const convId = uuidv4()
    await supabase
      .from('conversation_threads')
      .insert({
        id: convId,
        user_id: userId,
        topic: `Pozvánka: ${invitation.summary}`,
        state: 'active',
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        message_count: 0,
        messages_since_rebuild: 0,
      })
    conversationId = convId
  }

  // Calculate priority score for the invitation
  const priorityScore = calculatePriorityScore({
    dollarValue: 0,
    urgency: 5,
    painFactor: 3,
    daysIgnored: 0,
    weight: 50,
  })

  // Format the time for display
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

  const timeStr = `${formatDate(invitation.startTime)}, ${formatTime(invitation.startTime)} - ${formatTime(invitation.endTime)}`

  // Create action proposal for the user to review
  await createAction({
    id: uuidv4(),
    user_id: userId,
    conversation_id: conversationId,
    cp_id: cp.id,
    action_type: 'SCHEDULE',
    intent_cs: `${cp.name || invitation.organizer.email} vás zve na schůzku "${invitation.summary}" dne ${timeStr}. Navrhuji přijmout pozvánku.`,
    rationale_cs: `Obdržena pozvánka na schůzku od ${cp.name || invitation.organizer.email}.`,
    rationale: `Calendar invitation received from ${cp.name || invitation.organizer.email}`,
    missing_info: [{
      label: 'Chcete přijmout tuto pozvánku? (ano/ne/jiný čas)',
      value: null,
    }],
    priority_score: priorityScore,
    dollar_value: 0,
    urgency: 5,
    pain_factor: 3,
    payload: {
      intent_cs: `Pozvánka na schůzku od ${cp.name || invitation.organizer.email}`,
      execution_plan: `Přijmout/odmítnout pozvánku na ${invitation.summary}`,
      calendar_event_id: invitation.id,
      proposed_time: invitation.startTime.toISOString(),
      proposed_end: invitation.endTime.toISOString(),
      location: invitation.location || null,
      invitation_from: invitation.organizer.email,
      action_metadata: {
        action_type: 'SCHEDULE',
        urgency: 5,
        dollar_value: 0,
        pain_factor: 3,
      },
    },
    queued_for_brief: true,
  })

  return true
}
