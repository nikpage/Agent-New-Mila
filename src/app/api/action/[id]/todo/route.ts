import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateActionStatus } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { createTodo } from '@/lib/db/todos'
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

    // Get related data for the todo description
    const [conversation, cp] = await Promise.all([
      getConversationById(action.conversation_id),
      getCPById(action.cp_id),
    ])

    // Create a todo for this action
    const todoDescription = `${action.action_type}: ${conversation?.topic || 'Unknown topic'} (${cp?.name || cp?.primary_identifier || 'Unknown contact'})`

    await createTodo({
      user_id: action.user_id,
      cp_id: action.cp_id,
      thread_id: action.conversation_id,
      description: todoDescription,
      status: 'pending',
    })

    // Update action status to indicate user will handle it
    await updateActionStatus(actionId, 'needs_revision')

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Error creating todo:', error)
    return NextResponse.json(
      { error: 'Failed to create todo' },
      { status: 500 }
    )
  }
}
