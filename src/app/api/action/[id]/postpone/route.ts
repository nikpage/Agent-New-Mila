import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateAction } from '@/lib/db/actions'
import { validateActionToken } from '@/lib/auth/tokens'

/**
 * POST /api/action/[id]/postpone
 * Postpones an action by setting a new snooze-until date.
 * Used by the Odložit CTA (Dnes / Zítra / Příští týden).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token, postponeTo } = body

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    if (!postponeTo || typeof postponeTo !== 'string') {
      return NextResponse.json({ error: 'Missing postponeTo (today|tomorrow|next_week|ISO date)' }, { status: 400 })
    }

    const action = await getActionById(actionId)
    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    // Calculate the target date
    const now = new Date()
    let targetDate: Date

    switch (postponeTo) {
      case 'today': {
        // Later today — set to end of business (18:00)
        targetDate = new Date(now)
        targetDate.setHours(18, 0, 0, 0)
        if (targetDate <= now) {
          // Already past 18:00 — set to tomorrow morning
          targetDate.setDate(targetDate.getDate() + 1)
          targetDate.setHours(8, 0, 0, 0)
        }
        break
      }
      case 'tomorrow': {
        targetDate = new Date(now)
        targetDate.setDate(targetDate.getDate() + 1)
        targetDate.setHours(8, 0, 0, 0)
        break
      }
      case 'next_week': {
        targetDate = new Date(now)
        // Next Monday
        const dayOfWeek = targetDate.getDay()
        const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek
        targetDate.setDate(targetDate.getDate() + daysUntilMonday)
        targetDate.setHours(8, 0, 0, 0)
        break
      }
      default: {
        // Assume ISO date string
        targetDate = new Date(postponeTo)
        if (isNaN(targetDate.getTime())) {
          return NextResponse.json({ error: 'Invalid postponeTo value' }, { status: 400 })
        }
      }
    }

    // Store postpone date in payload and reset queued_for_brief so it reappears later
    const currentPayload = (action.payload as Record<string, unknown>) || {}
    await updateAction(actionId, {
      payload: {
        ...currentPayload,
        postponed_until: targetDate.toISOString(),
      },
      queued_for_brief: false,
    })

    return NextResponse.json({
      success: true,
      postponedUntil: targetDate.toISOString(),
    })
  } catch (error) {
    console.error('[Postpone]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to postpone' },
      { status: 500 }
    )
  }
}
