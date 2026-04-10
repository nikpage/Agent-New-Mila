import { NextRequest, NextResponse } from 'next/server'
import { getActionById, dismissAction } from '@/lib/db/actions'
import { validateActionToken } from '@/lib/auth/tokens'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token } = body

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    // Get the action
    const action = await getActionById(actionId)

    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    // Validate the token
    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    // Dismiss this action — user handles it themselves
    await dismissAction(actionId, action.user_id)

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Error dismissing action:', error)
    return NextResponse.json(
      { error: 'Failed to dismiss action' },
      { status: 500 }
    )
  }
}
