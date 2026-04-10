import { NextRequest, NextResponse } from 'next/server'
import { validateTriggerToken } from '@/lib/auth/tokens'
import { getEventById, updateEvent, findConflicts } from '@/lib/db/events'
import { updateCalendarEvent } from '@/lib/google/calendar'

/**
 * POST /api/brief/[userId]/reschedule-event
 * Moves a calendar event to a new time. Detects conflicts.
 * Auth: trigger token.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params
    const body = await request.json()
    const { token, eventId, newStart, newEnd } = body

    if (!token || !validateTriggerToken(token, userId)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    if (!eventId || !newStart || !newEnd) {
      return NextResponse.json({ error: 'Missing eventId, newStart, or newEnd' }, { status: 400 })
    }

    const event = await getEventById(eventId)
    if (!event || event.user_id !== userId) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    }

    const startDate = new Date(newStart)
    const endDate = new Date(newEnd)

    // Check for conflicts at the new time
    const conflicts = await findConflicts(userId, startDate, endDate, eventId)

    // Update in DB
    await updateEvent(eventId, {
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
    }, userId)

    // Update in Google Calendar if linked
    if (event.google_event_id) {
      try {
        await updateCalendarEvent(userId, event.google_event_id, {
          startTime: startDate,
          endTime: endDate,
        })
      } catch (err) {
        console.error('[RescheduleEvent] Google Calendar update failed:', err)
        // DB is already updated — don't fail the whole request
      }
    }

    return NextResponse.json({
      success: true,
      conflicts: conflicts.map(c => ({
        id: c.id,
        title: c.title,
        start_time: c.start_time,
        end_time: c.end_time,
        weight: c.weight,
      })),
    })
  } catch (error) {
    console.error('[RescheduleEvent]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}
