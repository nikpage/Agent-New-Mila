import { NextRequest, NextResponse } from 'next/server'
import { getActionById } from '@/lib/db/actions'
import { getConversationById, getRecentMessages } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { validateActionToken } from '@/lib/auth/tokens'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const token = request.nextUrl.searchParams.get('token')

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    // Get the action first to get the user ID for validation
    const action = await getActionById(actionId)

    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    // Validate the token
    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    // Get related data
    const [conversation, cp, recentMessages] = await Promise.all([
      getConversationById(action.conversation_id),
      getCPById(action.cp_id),
      getRecentMessages(action.conversation_id, 1),
    ])

    if (!conversation || !cp) {
      return NextResponse.json({ error: 'Data not found' }, { status: 404 })
    }

    return NextResponse.json({
      action,
      conversation,
      cp,
      recentMessage: recentMessages[0] || null,
    })
  } catch (error) {
    console.error('Error fetching action:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
