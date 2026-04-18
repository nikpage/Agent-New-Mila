import { getSupabaseAdmin } from '../supabase/client'
import type { Todo, TodoInsert } from '../supabase/types'

/**
 * Get a todo by ID
 */
export async function getTodoById(todoId: string): Promise<Todo | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('id', todoId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get todo: ${error.message}`)
  }

  return data
}

/**
 * Get todos for a user
 */
export async function getTodosForUser(
  userId: string,
  options?: {
    status?: string
    limit?: number
    includePast?: boolean
  }
): Promise<Todo[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)

  if (options?.status) {
    query = query.eq('status', options.status)
  }

  // By default, only show todos with future or null due dates
  if (!options?.includePast) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' })
    query = query.or(`due_date.gte.${today},due_date.is.null`)
  }

  query = query.order('due_date', { ascending: true, nullsFirst: false })

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get todos: ${error.message}`)
  }

  return data || []
}

/**
 * Get pending todos for a user
 */
export async function getPendingTodos(userId: string): Promise<Todo[]> {
  return getTodosForUser(userId, { status: 'pending' })
}

/**
 * Create a new todo
 */
export async function createTodo(todo: TodoInsert): Promise<Todo> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('todos')
    .insert({
      ...todo,
      status: todo.status || 'pending',
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create todo: ${error.message}`)
  }

  return data
}

/**
 * Update a todo
 */
export async function updateTodo(
  todoId: string,
  updates: Partial<Omit<Todo, 'id' | 'user_id' | 'created_at'>>
): Promise<Todo> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('todos')
    .update(updates)
    .eq('id', todoId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update todo: ${error.message}`)
  }

  return data
}

/**
 * Complete a todo
 */
export async function completeTodo(todoId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('todos')
    .update({ status: 'completed' })
    .eq('id', todoId)

  if (error) {
    throw new Error(`Failed to complete todo: ${error.message}`)
  }
}

/**
 * Delete a todo
 */
export async function deleteTodo(todoId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('todos')
    .delete()
    .eq('id', todoId)

  if (error) {
    throw new Error(`Failed to delete todo: ${error.message}`)
  }
}

/**
 * Get todos for a specific conversation
 */
export async function getTodosForThread(threadId: string): Promise<Todo[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('thread_id', threadId)
    .order('due_date', { ascending: true })

  if (error) {
    throw new Error(`Failed to get todos for thread: ${error.message}`)
  }

  return data || []
}

/**
 * Get overdue todos
 */
export async function getOverdueTodos(userId: string): Promise<Todo[]> {
  const supabase = getSupabaseAdmin()
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' })

  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .lt('due_date', today)
    .order('due_date', { ascending: true })

  if (error) {
    throw new Error(`Failed to get overdue todos: ${error.message}`)
  }

  return data || []
}

/**
 * Get todos due today
 */
export async function getTodosDueToday(userId: string): Promise<Todo[]> {
  const supabase = getSupabaseAdmin()
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' })

  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .eq('due_date', today)
    .order('scheduled_time', { ascending: true })

  if (error) {
    throw new Error(`Failed to get todos due today: ${error.message}`)
  }

  return data || []
}
