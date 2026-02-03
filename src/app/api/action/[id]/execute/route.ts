import { NextRequest, NextResponse } from 'next/server'
import { getActionById, completeAction } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { validateActionToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/lib/google/gmail'

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

    // Check action type and required data
    if (action.action_type === 'REPLY') {
      if (!action.draft_body_text) {
        return NextResponse.json(
          { error: 'No draft available to send' },
          { status: 400 }
        )
      }

      // Get the CP to get the email address
      const cp = await getCPById(action.cp_id)
      if (!cp) {
        return NextResponse.json({ error: 'Counterparty not found' }, { status: 404 })
      }

      // Send the email
      await sendEmail(action.user_id, {
        to: cp.primary_identifier,
        subject: action.draft_subject || 'Re: Your message',
        body: action.draft_body_text,
      })

      // Mark action as completed
      await completeAction(actionId)

      return NextResponse.json({ success: true, message: 'Email sent' })
    }

    if (action.action_type === 'SCHEDULE') {
      // For scheduling, we'll need additional handling
      // For now, just mark as completed
      await completeAction(actionId)
      return NextResponse.json({ success: true, message: 'Action completed' })
    }

    // For other action types, just mark as completed
    await completeAction(actionId)
    return NextResponse.json({ success: true, message: 'Action completed' })

  } catch (error) {
    console.error('Error executing action:', error)
    return NextResponse.json(
      { error: 'Failed to execute action' },
      { status: 500 }
    )
  }
}
