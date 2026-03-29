import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateAction, completeAction } from '@/lib/db/actions'
import { getEventById, cancelEventWithCleanup, rescheduleEvent } from '@/lib/db/events'
import { validateActionToken } from '@/lib/auth/tokens'
import { getUserSettings } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { generateConflictResolutionDraft } from '@/lib/ai/mila-voice'
import { confirmSlot, findBestSlots, blockSlotForProposal } from '@/services/scheduling'
import { updateCalendarEvent, deleteCalendarEvent } from '@/lib/google/calendar'
import { sendEmail } from '@/lib/google/gmail'
import type { ConflictCardData } from '@/components/action/action-card-template'
import type { Json } from '@/lib/supabase/types'

type ResolutionAction = 'reschedule_existing' | 'cancel_existing' | 'move_new' | 'keep_both'

/**
 * GET — Load conflict resolution details + generate draft on-demand.
 * Called when user clicks a resolution button from the email card.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const token = request.nextUrl.searchParams.get('token')
    const resolutionAction = request.nextUrl.searchParams.get('action') as ResolutionAction | null
    const conflictIdx = parseInt(request.nextUrl.searchParams.get('conflict_idx') || '0', 10)

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    const action = await getActionById(actionId)
    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    if (!resolutionAction || !['reschedule_existing', 'cancel_existing', 'move_new', 'keep_both'].includes(resolutionAction)) {
      return NextResponse.json({ error: 'Invalid resolution action' }, { status: 400 })
    }

    const payload = action.payload as Record<string, unknown> | null
    const conflicts = (payload?.conflicts as ConflictCardData[]) || []
    const conflict = conflicts[conflictIdx]

    if (!conflict) {
      return NextResponse.json({ error: 'Conflict not found — may have been resolved' }, { status: 404 })
    }

    // Check if this conflict was already resolved in a previous interaction
    if ((conflict as Record<string, unknown>).resolved) {
      return NextResponse.json({
        error: 'Tento konflikt již byl vyřešen.',
        resolved: true,
      }, { status: 409 })
    }

    // Check if the existing event still exists (may have been moved/cancelled already)
    const existingEvent = await getEventById(conflict.event_id)
    if (!existingEvent || existingEvent.status === 'cancelled') {
      return NextResponse.json({
        error: 'Tento konflikt již byl vyřešen — schůzka byla přesunuta nebo zrušena.',
        resolved: true,
      }, { status: 409 })
    }

    const settings = await getUserSettings(action.user_id)
    const tz = settings.timezone || 'Europe/Prague'

    // Format times for display
    const existingTimeStr = formatTimeRange(conflict.event_start, conflict.event_end, tz)
    const altTimeStr = conflict.alt_slot_start
      ? formatTimeRange(conflict.alt_slot_start, conflict.alt_slot_end || conflict.alt_slot_start, tz)
      : null

    // Generate draft for any resolution that might notify the existing event's CP.
    // The frontend decides whether to show it based on the selected resolution action.
    let draft: { subject: string; body: string } | null = null
    if (conflict.event_has_guests || conflict.event_cp_name) {
      const cpName = conflict.event_cp_name || 'participant'
      draft = await generateConflictResolutionDraft(
        resolutionAction === 'reschedule_existing' ? 'reschedule' : 'cancel',
        conflict.event_title,
        existingTimeStr,
        altTimeStr,
        cpName,
        conflict.deal_context,
        settings
      )
    }

    // Build human-readable summary of what will happen
    let summary: string
    if (resolutionAction === 'keep_both') {
      summary = `Ponechat obě schůzky — překryv s "${conflict.event_title}" je v pořádku. Nová schůzka bude potvrzena.`
    } else if (resolutionAction === 'reschedule_existing') {
      summary = `Přesunout "${conflict.event_title}" ${altTimeStr ? `na ${altTimeStr}` : 'na jiný termín'}. Nová schůzka bude potvrzena automaticky.`
    } else if (resolutionAction === 'cancel_existing') {
      summary = `Zrušit "${conflict.event_title}". Nová schůzka bude potvrzena automaticky.`
    } else {
      summary = `Vyberte nový termín pro schůzku. Stávající "${conflict.event_title}" zůstane beze změny.`
    }

    // Unified view: always provide available slots for slot picker
    const isUnified = request.nextUrl.searchParams.get('unified') === '1'
    const requestedDuration = parseInt(request.nextUrl.searchParams.get('duration') || '0', 10)
    const forceIntoSlot = request.nextUrl.searchParams.get('force') === '1'

    // Calculate durations
    const newEventDuration = payload?.start && payload?.end
      ? Math.round((new Date(payload.end as string).getTime() - new Date(payload.start as string).getTime()) / 60000)
      : null
    const existingEventDuration = Math.round(
      (new Date(conflict.event_end).getTime() - new Date(conflict.event_start).getTime()) / 60000
    )

    // Determine slot duration: use requested duration, or fall back to event duration
    const slotDuration = requestedDuration > 0
      ? requestedDuration
      : (resolutionAction === 'move_new' || isUnified)
        ? Math.max(5, newEventDuration || 30)
        : Math.max(5, existingEventDuration || 30)

    let availableSlots: { start: string; end: string; label: string; busy?: boolean }[] | undefined
    if (resolutionAction === 'move_new' || isUnified) {
      const slotCount = forceIntoSlot ? 20 : 10
      const freeSlots = await findBestSlots(action.user_id, slotDuration, slotCount)
      availableSlots = freeSlots.map(s => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        label: formatTimeRange(s.start.toISOString(), s.end.toISOString(), tz),
        busy: false,
      }))

      // If force mode, generate busy-overlay slots at working-hour intervals
      if (forceIntoSlot) {
        const existingStarts = new Set(availableSlots.map(s => s.start))
        const workStart = typeof settings.working_hours_start === 'number' ? settings.working_hours_start : parseInt(String(settings.working_hours_start || '8'), 10)
        const workEnd = typeof settings.working_hours_end === 'number' ? settings.working_hours_end : parseInt(String(settings.working_hours_end || '18'), 10)
        const now = new Date()
        // Generate slots every 30 min for the next 7 working days
        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
          const day = new Date(now)
          day.setDate(day.getDate() + dayOffset)
          for (let hour = workStart; hour < workEnd; hour++) {
            for (const minute of [0, 30]) {
              const slotStart = new Date(day)
              slotStart.setHours(hour, minute, 0, 0)
              if (slotStart <= now) continue
              const slotEnd = new Date(slotStart.getTime() + slotDuration * 60000)
              if (slotEnd.getHours() > workEnd || (slotEnd.getHours() === workEnd && slotEnd.getMinutes() > 0)) continue
              const iso = slotStart.toISOString()
              if (!existingStarts.has(iso)) {
                availableSlots.push({
                  start: iso,
                  end: slotEnd.toISOString(),
                  label: formatTimeRange(iso, slotEnd.toISOString(), tz),
                  busy: true,
                })
              }
            }
          }
        }
        // Sort all slots chronologically
        availableSlots.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      }
    }

    // New event title from action context
    const newEventTitle = (payload?.topic as string)
      || (action.cp_id ? (await getCPById(action.cp_id))?.name : null)
      || null
    const newEventCpName = action.cp_id ? (await getCPById(action.cp_id))?.name || null : null

    return NextResponse.json({
      action: resolutionAction,
      conflict,
      draft,
      summary,
      existingEvent: {
        title: conflict.event_title,
        time: existingTimeStr,
        cpName: conflict.event_cp_name,
        hasGuests: conflict.event_has_guests,
        durationMinutes: existingEventDuration,
      },
      newEvent: {
        title: newEventTitle,
        cpName: newEventCpName,
        durationMinutes: newEventDuration,
        start: (payload?.start as string) || null,
        end: (payload?.end as string) || null,
      },
      altSlot: altTimeStr ? { time: altTimeStr, start: conflict.alt_slot_start, end: conflict.alt_slot_end } : null,
      availableSlots,
      recommendation: conflict.recommendation,
    })
  } catch (error) {
    console.error('[ResolveConflict:GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}

/**
 * POST — Execute the conflict resolution.
 * One click does both: resolve conflict + confirm new event.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const {
      token, action: resolutionAction, conflict_idx: conflictIdx = 0,
      edited_draft, selected_slot, new_duration, existing_duration,
      force_into_slot, meeting_mode, location: meetingLocation, target_event,
    } = body as {
      token: string
      action: ResolutionAction
      conflict_idx?: number
      edited_draft?: { subject: string; body: string }
      selected_slot?: { start: string; end: string }
      new_duration?: number
      existing_duration?: number
      force_into_slot?: boolean
      meeting_mode?: 'address' | 'online' | 'phone'
      location?: string
      target_event?: 'new' | 'existing'
    }

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    // Fresh fetch — never use stale data
    const actionRecord = await getActionById(actionId)
    if (!actionRecord) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    if (!validateActionToken(token, actionId, actionRecord.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    if (actionRecord.status !== 'pending' && actionRecord.status !== 'approved') {
      return NextResponse.json(
        { error: 'Action already resolved', status: actionRecord.status },
        { status: 409 }
      )
    }

    const payload = actionRecord.payload as Record<string, unknown> | null
    const conflicts = (payload?.conflicts as ConflictCardData[]) || []
    const conflict = conflicts[conflictIdx]

    if (!conflict) {
      return NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
    }

    if ((conflict as Record<string, unknown>).resolved) {
      return NextResponse.json({ success: true, message: 'Tento konflikt již byl vyřešen.', resolved: true })
    }

    // Re-check existing event is still there
    const existingEvent = await getEventById(conflict.event_id)
    if (!existingEvent || existingEvent.status === 'cancelled') {
      // Conflict gone — remove from payload and let user proceed normally
      const updatedConflicts = conflicts.map((c, i) => i === conflictIdx ? { ...c, resolved: true } : c)
      const freshAction = await getActionById(actionId)
      const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...freshPayload, conflicts: updatedConflicts } as unknown as Json,
      })
      return NextResponse.json({ success: true, message: 'Conflict already resolved', resolved: true })
    }

    const userId = actionRecord.user_id
    const settings = await getUserSettings(userId)

    // ── Duration changes (optional, before main resolution) ────────────
    if (existing_duration && existing_duration > 0) {
      const existingEvt = await getEventById(conflict.event_id)
      if (existingEvt && existingEvt.google_event_id) {
        const newEnd = new Date(new Date(conflict.event_start).getTime() + existing_duration * 60000)
        await updateCalendarEvent(userId, existingEvt.google_event_id, {
          endTime: newEnd,
        })
        const { updateEvent: updateDbEvent } = await import('@/lib/db/events')
        await updateDbEvent(conflict.event_id, { end_time: newEnd.toISOString() })
      }
    }
    if (new_duration && new_duration > 0 && payload?.hold_event_id) {
      const holdEvt = await getEventById(payload.hold_event_id as string)
      if (holdEvt && holdEvt.google_event_id) {
        const holdStart = new Date(payload.start as string)
        const newEnd = new Date(holdStart.getTime() + new_duration * 60000)
        await updateCalendarEvent(userId, holdEvt.google_event_id, {
          endTime: newEnd,
        })
        const { updateEvent: updateDbEvent } = await import('@/lib/db/events')
        await updateDbEvent(holdEvt.id, { end_time: newEnd.toISOString() })
        // Update the action payload with new end time
        const latestAction = await getActionById(actionId)
        const latestPayload = (latestAction?.payload as Record<string, unknown>) || {}
        await updateAction(actionId, {
          payload: { ...latestPayload, end: newEnd.toISOString() } as unknown as Json,
        })
      }
    }

    if (resolutionAction === 'keep_both') {
      // User accepts the overlap — resolve conflict, confirm new event, complete action
      const updatedConflicts = conflicts.map((c, i) => i === conflictIdx ? { ...c, resolved: true } : c)
      const freshAction = await getActionById(actionId)
      const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...freshPayload, conflicts: updatedConflicts } as unknown as Json,
      })

      // Check if all conflicts are now resolved — if so, confirm the new event
      const allResolved = updatedConflicts.every((c: Record<string, unknown>) => c.resolved)
      if (allResolved) {
        await confirmNewEventAndComplete(actionId, userId, payload, settings)
      }

      return NextResponse.json({ success: true, resolution: 'keep_both' })
    }

    if (resolutionAction === 'reschedule_existing') {
      // 1. Reschedule existing event to alt slot
      if (!conflict.alt_slot_start) {
        return NextResponse.json({ error: 'No alternative slot available' }, { status: 400 })
      }
      const altStart = new Date(conflict.alt_slot_start)
      const altEnd = conflict.alt_slot_end
        ? new Date(conflict.alt_slot_end)
        : new Date(altStart.getTime() + (new Date(conflict.event_end).getTime() - new Date(conflict.event_start).getTime()))

      await rescheduleEvent(userId, conflict.event_id, altStart, altEnd, updateCalendarEvent)

      // 2. If event has guests, send notification
      if ((conflict.event_has_guests || conflict.event_cp_name) && edited_draft) {
        const cpEmail = await getCpEmailFromEvent(existingEvent, conflict)
        if (cpEmail) {
          await sendEmail(userId, {
            to: cpEmail,
            subject: edited_draft.subject,
            body: edited_draft.body,
          })
        }
      }

      // 3. Confirm the NEW event + complete the action
      await confirmNewEventAndComplete(actionId, userId, payload, settings)

      return NextResponse.json({ success: true, resolution: 'reschedule_existing' })

    } else if (resolutionAction === 'cancel_existing') {
      // 1. Cancel existing event
      await cancelEventWithCleanup(conflict.event_id)

      // 2. If event has guests, send cancellation
      if ((conflict.event_has_guests || conflict.event_cp_name) && edited_draft) {
        const cpEmail = await getCpEmailFromEvent(existingEvent, conflict)
        if (cpEmail) {
          await sendEmail(userId, {
            to: cpEmail,
            subject: edited_draft.subject,
            body: edited_draft.body,
          })
        }
      }

      // 3. Confirm the NEW event + complete the action
      await confirmNewEventAndComplete(actionId, userId, payload, settings)

      return NextResponse.json({ success: true, resolution: 'cancel_existing' })

    } else if (resolutionAction === 'move_new') {
      // 1. Delete current hold for the new event (DB + Google Calendar)
      const holdEventId = payload?.hold_event_id as string | null
      if (holdEventId) {
        const holdEvent = await getEventById(holdEventId)
        // Delete travel buffers from GCal
        const { getTravelBuffers, cleanupTravelBuffers } = await import('@/lib/db/events')
        const travelBuffers = await getTravelBuffers(holdEventId)
        for (const buf of travelBuffers) {
          if (buf.google_event_id) {
            try {
              await deleteCalendarEvent(userId, buf.google_event_id, 'none')
            } catch (e) {
              console.error('[ResolveConflict] Failed to delete travel buffer from GCal:', e)
            }
          }
        }
        await cleanupTravelBuffers(holdEventId)
        // Delete hold from GCal
        if (holdEvent?.google_event_id) {
          try {
            await deleteCalendarEvent(userId, holdEvent.google_event_id, 'none')
          } catch (e) {
            console.error('[ResolveConflict] Failed to delete hold from GCal:', e)
          }
        }
        // Delete hold from DB
        const { deleteEvent: deleteDbEvent } = await import('@/lib/db/events')
        await deleteDbEvent(holdEventId)
      }

      // 2. Use user-selected slot or find one automatically
      const durationMinutes = new_duration && new_duration > 0
        ? new_duration
        : (() => {
          const durationMs = payload?.start && payload?.end
            ? new Date(payload.end as string).getTime() - new Date(payload.start as string).getTime()
            : new Date(conflict.event_end).getTime() - new Date(conflict.event_start).getTime()
          return Math.max(5, Math.round(durationMs / 60000))
        })()

      let newSlot: { start: Date; end: Date }
      if (selected_slot) {
        // User picked a specific slot (may be a busy slot if force_into_slot)
        newSlot = {
          start: new Date(selected_slot.start),
          end: new Date(selected_slot.end),
        }
      } else {
        // Fallback: auto-find (backward compat)
        const newSlots = await findBestSlots(userId, durationMinutes, 1)
        if (newSlots.length === 0) {
          return NextResponse.json({ error: 'No available slot found for the new meeting' }, { status: 400 })
        }
        newSlot = newSlots[0]
      }

      // 3. Determine location from meeting_mode
      const effectiveLocation = meeting_mode === 'online'
        ? null
        : meeting_mode === 'phone'
          ? null
          : (meetingLocation || (payload?.location as string | null))
      const isOnline = meeting_mode === 'online'

      // 4. Create new hold at the new slot
      const holdResult = await blockSlotForProposal(
        userId,
        actionRecord.cp_id,
        newSlot,
        durationMinutes,
        effectiveLocation || undefined
      )

      if (!holdResult.success || !holdResult.holdEvent) {
        return NextResponse.json({ error: holdResult.error || 'Failed to create new hold' }, { status: 500 })
      }

      // 5. Update action payload with new hold info — fresh fetch to avoid stale writes
      const freshMoveAction = await getActionById(actionId)
      const freshMovePayload = (freshMoveAction?.payload as Record<string, unknown>) || {}
      const updatedConflicts = conflicts.map((c, i) => i === conflictIdx ? { ...c, resolved: true } : c)
      await updateAction(actionId, {
        payload: {
          ...freshMovePayload,
          hold_event_id: holdResult.holdEvent.id,
          start: newSlot.start.toISOString(),
          end: newSlot.end.toISOString(),
          conflicts: updatedConflicts,
          ...(meeting_mode ? { meeting_type: meeting_mode } : {}),
          ...(isOnline ? { is_online: true } : {}),
          ...(effectiveLocation ? { location: effectiveLocation } : {}),
          ...(force_into_slot ? { forced_into_slot: true } : {}),
        } as unknown as Json,
      })

      return NextResponse.json({
        success: true,
        resolution: 'move_new',
        newSlot: {
          start: newSlot.start.toISOString(),
          end: newSlot.end.toISOString(),
        },
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('[ResolveConflict:POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeRange(startIso: string, endIso: string, tz: string): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const dateStr = s.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })
  const startStr = s.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const endStr = e.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  return `${dateStr}, ${startStr} – ${endStr}`
}

async function getCpEmailFromEvent(
  event: { cp_id?: string | null; google_event_id?: string | null },
  conflict: ConflictCardData
): Promise<string | null> {
  // Try to get email from CP record
  if (conflict.event_cp_id) {
    const cp = await getCPById(conflict.event_cp_id)
    if (cp?.primary_identifier?.includes('@')) return cp.primary_identifier
  }
  // Fallback: no email available — manual notification needed
  return null
}

/**
 * Confirm the new event (from the action's hold) and complete the action.
 * Reuses confirmSlot from scheduling.ts.
 */
async function confirmNewEventAndComplete(
  actionId: string,
  userId: string,
  payload: Record<string, unknown> | null,
  _settings: unknown
): Promise<void> {
  const holdEventId = payload?.hold_event_id as string | null

  if (holdEventId) {
    const cp = payload?.cp_id ? await getCPById(payload.cp_id as string) : null
    const cpEmail = cp?.primary_identifier?.includes('@') ? cp.primary_identifier : undefined
    const isOnline = !!payload?.is_online
    const location = payload?.location as string | undefined

    await confirmSlot(
      userId,
      holdEventId,
      cpEmail,
      location,
      undefined,
      undefined,
      isOnline
    )
  }

  // Remove conflicts from payload and complete
  const freshAction = await getActionById(actionId)
  const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
  await updateAction(actionId, {
    payload: { ...freshPayload, conflicts: [] } as unknown as Json,
  })
  await completeAction(actionId)
}
