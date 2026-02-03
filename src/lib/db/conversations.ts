import { getSupabaseAdmin } from '../supabase/client'
import type {
  ConversationThread,
  ConversationThreadInsert,
  ConversationSummary,
  Message,
  ThreadParticipant
} from '../supabase/types'

/**
 * Get a conversation thread by ID
 */
export async function getConversationById(threadId: string): Promise<ConversationThread | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('conversation_threads')
    .select('*')
    .eq('id', threadId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get conversation: ${error.message}`)
  }

  return data
}

/**
 * Get all conversations for a user
 */
export async function getConversationsForUser(
  userId: string,
  options?: {
    limit?: number
    state?: string
    orderBy?: 'last_updated' | 'priority_score' | 'created_at'
  }
): Promise<ConversationThread[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('conversation_threads')
    .select('*')
    .eq('user_id', userId)

  if (options?.state) {
    query = query.eq('state', options.state)
  }

  const orderBy = options?.orderBy || 'last_updated'
  query = query.order(orderBy, { ascending: false, nullsFirst: false })

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get conversations: ${error.message}`)
  }

  return data || []
}

/**
 * Create a new conversation thread
 */
export async function createConversation(
  thread: ConversationThreadInsert
): Promise<ConversationThread> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('conversation_threads')
    .insert({
      ...thread,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      message_count: 0,
      messages_since_rebuild: 0,
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create conversation: ${error.message}`)
  }

  return data
}

/**
 * Update a conversation thread
 */
export async function updateConversation(
  threadId: string,
  updates: Partial<Omit<ConversationThread, 'id' | 'user_id' | 'created_at'>>
): Promise<ConversationThread> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('conversation_threads')
    .update({
      ...updates,
      last_updated: new Date().toISOString(),
    })
    .eq('id', threadId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update conversation: ${error.message}`)
  }

  return data
}

/**
 * Update conversation summary
 */
export async function updateConversationSummary(
  threadId: string,
  summary: ConversationSummary,
  summaryText: string,
  confidence: number,
  confidenceReason?: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('conversation_threads')
    .update({
      summary_json: summary as unknown as Record<string, unknown>,
      summary_text: summaryText,
      summary_confidence: confidence,
      summary_confidence_reason: confidenceReason || null,
      messages_since_rebuild: 0,
      last_updated: new Date().toISOString(),
    })
    .eq('id', threadId)

  if (error) {
    throw new Error(`Failed to update conversation summary: ${error.message}`)
  }
}

/**
 * Increment message count for a conversation
 */
export async function incrementMessageCount(threadId: string): Promise<void> {
  const supabase = getSupabaseAdmin()

  // Get current counts
  const { data: thread } = await supabase
    .from('conversation_threads')
    .select('message_count, messages_since_rebuild')
    .eq('id', threadId)
    .single()

  if (!thread) return

  const { error } = await supabase
    .from('conversation_threads')
    .update({
      message_count: (thread.message_count || 0) + 1,
      messages_since_rebuild: (thread.messages_since_rebuild || 0) + 1,
      last_updated: new Date().toISOString(),
    })
    .eq('id', threadId)

  if (error) {
    throw new Error(`Failed to increment message count: ${error.message}`)
  }
}

/**
 * Get messages for a conversation
 */
export async function getMessagesForConversation(
  conversationId: string,
  options?: { limit?: number; offset?: number }
): Promise<Message[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: true })

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  if (options?.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get messages: ${error.message}`)
  }

  return data || []
}

/**
 * Get the most recent messages for a conversation
 */
export async function getRecentMessages(
  conversationId: string,
  limit: number = 10
): Promise<Message[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get recent messages: ${error.message}`)
  }

  // Return in chronological order
  return (data || []).reverse()
}

/**
 * Add a participant to a conversation
 */
export async function addParticipant(
  threadId: string,
  cpId: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('thread_participants')
    .upsert({
      thread_id: threadId,
      cp_id: cpId,
      added_at: new Date().toISOString(),
    }, {
      onConflict: 'thread_id,cp_id',
    })

  if (error) {
    throw new Error(`Failed to add participant: ${error.message}`)
  }
}

/**
 * Get participants for a conversation
 */
export async function getParticipants(threadId: string): Promise<ThreadParticipant[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('thread_participants')
    .select('*')
    .eq('thread_id', threadId)

  if (error) {
    throw new Error(`Failed to get participants: ${error.message}`)
  }

  return data || []
}

/**
 * Find conversation by external thread ID (e.g., Gmail thread ID)
 */
export async function findConversationByExternalThread(
  userId: string,
  externalThreadId: string
): Promise<ConversationThread | null> {
  const supabase = getSupabaseAdmin()

  // First find a message with this external thread ID
  const { data: message } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('user_id', userId)
    .eq('external_thread_id', externalThreadId)
    .limit(1)
    .single()

  if (!message?.conversation_id) return null

  return getConversationById(message.conversation_id)
}
