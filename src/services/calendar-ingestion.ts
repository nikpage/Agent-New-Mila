/**
 * Calendar Event Ingestion Service
 * Syncs Google Calendar events to local events table
 * Detects incoming invitations and creates action proposals
 */

import {
  getUpcomingCalendarEvents,
  getPendingInvitations,
  isIncomingInvitation,
  MILA_MANAGED_KEY,
  type CalendarEvent,
} from '@/lib/google/calendar'
import {
  createEvent,
  getEventsInRange,
  getEventById,
  updateEvent,
  upsertEventByGoogleId,
} from '@/lib/db/events'
import { calculateEventScore } from '@/lib/db/events'
import { getUserById } from '@/lib/db/users'
import { getUserSettings } from '@/lib/db/users'
import { getCPByIdentifier, findOrCreateCP, isSameGmailAddress } from '@/lib/db/counterparties'
import { addParticipant } from '@/lib/db/conversations'
import { createAction, hasPendingAction, calculatePriorityScore } from '@/lib/db/actions'
import { createTodo } from '@/lib/db/todos'
import { isPersonalEvent } from '@/config/client'
import type { UserSettings } from '@/lib/supabase/types'
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
        // Skip events created by Mila (holds, travel buffers, etc.)
        // These are tagged with extendedProperties.private.milaManaged = "true"
        // at creation time. Without this check, a DB wipe would cause Mila to
        // re-import its own holds as plain meetings, creating duplicates.
        if (gcalEvent.extendedProperties?.[MILA_MANAGED_KEY] === 'true') {
          continue
        }

        await syncGoogleEventToLocal(userId, gcalEvent, settings.timezone, settings)
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
            const actionCreated = await processInvitation(userId, user.email, invitation, settings)
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
 * Sync a Google Calendar event to the local events table.
 * Uses the stable Google event ID for deduplication instead of the fragile
 * (start_time, end_time, title) match.
 */
async function syncGoogleEventToLocal(
  userId: string,
  gcalEvent: CalendarEvent,
  timezone: string,
  settings: UserSettings
): Promise<void> {
  const supabase = getSupabaseAdmin()

  // Check if this event already exists locally (for ToDo creation — only on first sync)
  const { data: existingEvents } = await supabase
    .from('events')
    .select('id')
    .eq('user_id', userId)
    .eq('google_event_id', gcalEvent.id)
    .limit(1)
  const isNewEvent = !existingEvents || existingEvents.length === 0

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

  // Upsert using the stable Google Calendar event ID.
  // If the event already exists locally (matched by google_event_id + user_id),
  // it will be updated with the latest values from Google Calendar.
  // If it's new, a fresh record is created with google_event_id set.
  await upsertEventByGoogleId(gcalEvent.id, userId, {
    cp_id: cpId,
    title: gcalEvent.summary,
    description: gcalEvent.description || null,
    location: gcalEvent.location || null,
    event_type: 'meeting',
    status: gcalEvent.status === 'cancelled' ? 'cancelled' : 'confirmed',
    start_time: gcalEvent.startTime.toISOString(),
    end_time: gcalEvent.endTime.toISOString(),
  })

  // For NEW non-personal events: create a ToDo for the user to set weight (and optionally CP)
  if (isNewEvent && !isPersonalEvent(gcalEvent.summary || '', settings)) {
    try {
      const dateStr = gcalEvent.startTime.toLocaleDateString('cs-CZ', {
        day: 'numeric',
        month: 'long',
      })
      await createTodo({
        user_id: userId,
        cp_id: cpId,
        description: `Nastavit váhu${!cpId ? ' a protistranu' : ''} pro: "${gcalEvent.summary}" (${dateStr})`,
        status: 'pending',
        due_date: gcalEvent.startTime.toISOString().split('T')[0],
      })
    } catch (error) {
      console.error(`Failed to create weight-setting todo for event ${gcalEvent.id}:`, error)
    }
  }
}

/**
 * Process an incoming calendar invitation
 * Creates a SCHEDULE action proposal for user review
 */
async function processInvitation(
  userId: string,
  userEmail: string,
  invitation: CalendarEvent,
  settings: UserSettings
): Promise<boolean> {
  if (!invitation.organizer?.email) return false

  // Personal events block time but don't generate action proposals
  if (isPersonalEvent(invitation.summary || '', settings)) return false

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

  // We need a conversation_id - find an existing conversation with this CP
  // First, find thread IDs where this CP is a participant
  const { data: cpThreads } = await supabase
    .from('thread_participants')
    .select('thread_id')
    .eq('cp_id', cp.id)

  let conversationId: string | null = null

  if (cpThreads && cpThreads.length > 0) {
    // Find a conversation thread that belongs to this user AND has this CP as participant
    const threadIds = cpThreads.map((t: { thread_id: string }) => t.thread_id)
    const { data: existingConv } = await supabase
      .from('conversation_threads')
      .select('id')
      .eq('user_id', userId)
      .in('id', threadIds)
      .order('last_updated', { ascending: false })
      .limit(1)

    if (existingConv && existingConv.length > 0) {
      conversationId = existingConv[0].id
    }
  }

  // If no conversation exists for this CP, create a new one and link the CP as participant
  if (!conversationId) {
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
    await addParticipant(convId, cp.id)
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
