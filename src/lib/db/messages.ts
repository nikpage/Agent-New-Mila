import { getSupabaseAdmin } from '../supabase/client'
import type { Message, MessageInsert } from '../supabase/types'

/**
 * Get a message by ID
 */
export async function getMessageById(messageId: string): Promise<Message | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get message: ${error.message}`)
  }

  return data
}

/**
 * Get a message by external ID (e.g., Gmail message ID)
 */
export async function getMessageByExternalId(
  userId: string,
  externalId: string
): Promise<Message | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .eq('external_id', externalId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get message by external ID: ${error.message}`)
  }

  return data
}

/**
 * Check if a message already exists
 */
export async function messageExists(
  userId: string,
  externalId: string
): Promise<boolean> {
  const message = await getMessageByExternalId(userId, externalId)
  return message !== null
}

/**
 * Create a new message
 */
export async function createMessage(message: MessageInsert): Promise<Message> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .insert(message)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create message: ${error.message}`)
  }

  return data
}

/**
 * Create multiple messages
 */
export async function createMessages(messages: MessageInsert[]): Promise<Message[]> {
  if (messages.length === 0) return []

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .insert(messages)
    .select()

  if (error) {
    throw new Error(`Failed to create messages: ${error.message}`)
  }

  return data || []
}

/**
 * Update a message
 */
export async function updateMessage(
  messageId: string,
  updates: Partial<Omit<Message, 'id' | 'user_id' | 'timestamp'>>
): Promise<Message> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .update(updates)
    .eq('id', messageId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update message: ${error.message}`)
  }

  return data
}

/**
 * Get messages for a user within a time range
 */
export async function getMessagesInRange(
  userId: string,
  startDate: Date,
  endDate: Date
): Promise<Message[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .gte('timestamp', startDate.toISOString())
    .lte('timestamp', endDate.toISOString())
    .order('timestamp', { ascending: true })

  if (error) {
    throw new Error(`Failed to get messages in range: ${error.message}`)
  }

  return data || []
}

/**
 * Get unprocessed messages (no conversation assigned)
 */
export async function getUnprocessedMessages(
  userId: string,
  limit: number = 100
): Promise<Message[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .is('conversation_id', null)
    .order('timestamp', { ascending: true })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get unprocessed messages: ${error.message}`)
  }

  return data || []
}

/**
 * Assign a message to a conversation
 */
export async function assignMessageToConversation(
  messageId: string,
  conversationId: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('messages')
    .update({ conversation_id: conversationId })
    .eq('id', messageId)

  if (error) {
    throw new Error(`Failed to assign message to conversation: ${error.message}`)
  }
}

/**
 * Get the latest message from a CP
 */
export async function getLatestMessageFromCP(
  userId: string,
  cpId: string
): Promise<Message | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .eq('cp_id', cpId)
    .eq('direction', 'INBOUND')
    .order('timestamp', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get latest message from CP: ${error.message}`)
  }

  return data
}

/**
 * Count messages in a conversation
 */
export async function countMessagesInConversation(conversationId: string): Promise<number> {
  const supabase = getSupabaseAdmin()
  const { count, error } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)

  if (error) {
    throw new Error(`Failed to count messages: ${error.message}`)
  }

  return count || 0
}
