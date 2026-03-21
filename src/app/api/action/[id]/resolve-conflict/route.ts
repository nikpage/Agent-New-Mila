import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateAction, completeAction } from '@/lib/db/actions'
import { getEventById, cancelEventWithCleanup, rescheduleEvent } from '@/lib/db/events'
import { validateActionToken } from '@/lib/auth/tokens'
import { getUserSettings } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { generateConflictResolutionDraft } from '@/lib/ai/mila-voice'
import { confirmSlot, findBestSlots, blockSlotForProposal } from '@/services/scheduling'
import { updateCalendarEvent } from '@/lib/google/calendar'
import { sendEmail } from '@/lib/google/gmail'
import type { ConflictCardData } from '@/components/action/action-card-template'
import type { Json } from '@/lib/supabase/types'

type ResolutionAction = 'reschedule_existing' | 'cancel_existing' | 'move_new'

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

    if (!resolutionAction || !['reschedule_existing', 'cancel_existing', 'move_new'].includes(resolutionAction)) {
      return NextResponse.json({ error: 'Invalid resolution action' }, { status: 400 })
    }

    const payload = action.payload as Record<string, unknown> | null
    const conflicts = (payload?.conflicts as ConflictCardData[]) || []
    const conflict = conflicts[conflictIdx]

    if (!conflict) {
      return NextResponse.json({ error: 'Conflict not found — may have been resolved' }, { status: 404 })
    }

    // Check if the existing event still exists (may have been moved/cancelled already)
    const existingEvent = await getEventById(conflict.event_id)
    if (!existingEvent || existingEvent.status === 'cancelled') {
      return NextResponse.json({
        error: 'Conflict already resolved — the existing event was moved or cancelled',
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

    // Generate draft only if event has guests/CP that need to be notified
    let draft: { subject: string; body: string } | null = null
    if (resolutionAction !== 'move_new' && (conflict.event_has_guests || conflict.event_cp_name)) {
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
    if (resolutionAction === 'reschedule_existing') {
      summary = `Přesunout "${conflict.event_title}" ${altTimeStr ? `na ${altTimeStr}` : 'na jiný termín'}. Nová schůzka bude potvrzena automaticky.`
    } else if (resolutionAction === 'cancel_existing') {
      summary = `Zrušit "${conflict.event_title}". Nová schůzka bude potvrzena automaticky.`
    } else {
      summary = `Přesunout novou schůzku na jiný termín. Stávající "${conflict.event_title}" zůstane beze změny.`
    }

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
      },
      altSlot: altTimeStr ? { time: altTimeStr, start: conflict.alt_slot_start, end: conflict.alt_slot_end } : null,
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
    const { token, action: resolutionAction, conflict_idx: conflictIdx = 0, edited_draft } = body as {
      token: string
      action: ResolutionAction
      conflict_idx?: number
      edited_draft?: { subject: string; body: string }
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

    // Re-check existing event is still there
    const existingEvent = await getEventById(conflict.event_id)
    if (!existingEvent || existingEvent.status === 'cancelled') {
      // Conflict gone — remove from payload and let user proceed normally
      const updatedConflicts = conflicts.filter((_, i) => i !== conflictIdx)
      const freshAction = await getActionById(actionId)
      const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...freshPayload, conflicts: updatedConflicts } as unknown as Json,
      })
      return NextResponse.json({ success: true, message: 'Conflict already resolved', resolved: true })
    }

    const userId = actionRecord.user_id
    const settings = await getUserSettings(userId)

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
      // 1. Cancel current hold for the new event
      const holdEventId = payload?.hold_event_id as string | null
      if (holdEventId) {
        await cancelEventWithCleanup(holdEventId)
      }

      // 2. Find a new slot that doesn't conflict
      const durationMs = new Date(conflict.event_end).getTime() - new Date(conflict.event_start).getTime()
      const durationMinutes = Math.max(30, Math.round(durationMs / 60000))
      const newSlots = await findBestSlots(userId, durationMinutes, 1)

      if (newSlots.length === 0) {
        return NextResponse.json({ error: 'No available slot found for the new meeting' }, { status: 400 })
      }

      const newSlot = newSlots[0]

      // 3. Create new hold at the new slot
      const location = payload?.location as string | null

      const holdResult = await blockSlotForProposal(
        userId,
        actionRecord.cp_id,
        newSlot,
        durationMinutes,
        location || undefined
      )

      if (!holdResult.success || !holdResult.holdEvent) {
        return NextResponse.json({ error: holdResult.error || 'Failed to create new hold' }, { status: 500 })
      }

      // 4. Update action payload with new hold info — fresh fetch to avoid stale writes
      const latestAction = await getActionById(actionId)
      const latestPayload = (latestAction?.payload as Record<string, unknown>) || {}
      const updatedConflicts = conflicts.filter((_, i) => i !== conflictIdx)
      await updateAction(actionId, {
        payload: {
          ...latestPayload,
          hold_event_id: holdResult.holdEvent.id,
          start: newSlot.start.toISOString(),
          end: newSlot.end.toISOString(),
          conflicts: updatedConflicts,
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
