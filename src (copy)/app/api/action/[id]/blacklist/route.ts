import { NextRequest, NextResponse } from 'next/server'
import { getActionById, dismissAction } from '@/lib/db/actions'
import { blacklistCP } from '@/lib/db/counterparties'
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

    // Blacklist the CP
    await blacklistCP(action.cp_id)

    // Dismiss this action
    await dismissAction(actionId)

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Error blacklisting CP:', error)
    return NextResponse.json(
      { error: 'Failed to blacklist contact' },
      { status: 500 }
    )
  }
}
