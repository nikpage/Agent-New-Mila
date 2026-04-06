import { NextRequest, NextResponse } from 'next/server'
import { getTodoById, completeTodo } from '@/lib/db/todos'
import { validateTriggerToken } from '@/lib/auth/tokens'

/**
 * POST /api/todo/[id]/complete
 * Marks a todo as completed. Auth: trigger token (tied to user_id on the todo).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: todoId } = await params
    const body = await request.json()
    const { token, userId } = body

    if (!token || !userId) {
      return NextResponse.json({ error: 'Missing token or userId' }, { status: 401 })
    }

    const todo = await getTodoById(todoId)
    if (!todo) {
      return NextResponse.json({ error: 'Todo not found' }, { status: 404 })
    }

    // Verify the todo belongs to this user and the trigger token is valid
    if (todo.user_id !== userId || !validateTriggerToken(token, userId)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await completeTodo(todoId)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[TodoComplete]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to complete todo' },
      { status: 500 }
    )
  }
}
