import { getSupabaseAdmin } from '../supabase/client'

/**
 * Save message embedding
 */
export async function saveMessageEmbedding(
  messageId: string,
  embedding: number[]
): Promise<void> {
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('message_embeddings')
    .insert({
      message_id: messageId,
      embedding: embedding,
    })

  if (error) {
    throw new Error(`Failed to save message embedding: ${error.message}`)
  }
}

/**
 * Save conversation embedding
 */
export async function saveConversationEmbedding(
  conversationId: string,
  embedding: number[]
): Promise<void> {
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('conversation_threads')
    .update({
      embedding: embedding,
    })
    .eq('id', conversationId)

  if (error) {
    throw new Error(`Failed to save conversation embedding: ${error.message}`)
  }
}
