import { NextRequest, NextResponse } from 'next/server'
import { getActionById, dismissAction } from '@/lib/db/actions'
import { createTodo } from '@/lib/db/todos'
import { validateActionToken } from '@/lib/auth/tokens'

/**
 * POST /api/action/[id]/convert-todo
 * Converts an action proposal to a TODO item.
 * Creates the todo, then dismisses the original action.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token, description: customDescription } = body

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

    // Create a TODO — use custom description if provided (question-specific todo)
    const description = customDescription || action.intent_cs || action.rationale_cs || action.rationale
    const todo = await createTodo({
      user_id: action.user_id,
      description,
      thread_id: action.conversation_id,
      cp_id: action.cp_id,
    })

    // Only dismiss the action if this is a full conversion (no custom description).
    // Question-specific todos (with custom description) keep the parent action alive.
    if (!customDescription) {
      await dismissAction(actionId, action.user_id)
    }

    return NextResponse.json({
      success: true,
      todoId: todo?.id || null,
    })
  } catch (error) {
    console.error('[ConvertTodo]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to convert to todo' },
      { status: 500 }
    )
  }
}
