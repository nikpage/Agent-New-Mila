import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateAction } from '@/lib/db/actions'
import { validateActionToken } from '@/lib/auth/tokens'
import { blockSlotForProposal } from '@/services/scheduling'

/**
 * POST /api/action/[id]/book-slot
 * Manually book a slot for a SCHEDULE action that has no hold event.
 * Used when time extraction failed and the user picks a time via datetime picker.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token, start, end, location } = body

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    if (!start || !end) {
      return NextResponse.json({ error: 'Missing start/end time' }, { status: 400 })
    }

    const action = await getActionById(actionId)
    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    if (action.action_type !== 'SCHEDULE') {
      return NextResponse.json({ error: 'Action is not a SCHEDULE type' }, { status: 400 })
    }

    const startDate = new Date(start)
    const endDate = new Date(end)
    const durationMinutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000)

    const result = await blockSlotForProposal(
      action.user_id,
      action.cp_id,
      { start: startDate, end: endDate },
      durationMinutes,
      location,
      action.weight ?? undefined,
      action.conversation_id
    )

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to book slot' }, { status: 500 })
    }

    // Update action payload with the new hold event details
    const currentPayload = (action.payload as Record<string, unknown>) || {}
    await updateAction(actionId, {
      payload: {
        ...currentPayload,
        hold_event_id: result.holdEvent?.id,
        gcal_event_id: result.gcalEventId,
        start,
        end,
        location: location || currentPayload.location,
      },
    }, action.user_id)

    return NextResponse.json({
      success: true,
      holdEventId: result.holdEvent?.id,
      gcalEventId: result.gcalEventId,
    })
  } catch (error) {
    console.error('[BookSlot]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to book slot' },
      { status: 500 }
    )
  }
}
