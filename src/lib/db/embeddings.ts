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
    .upsert({
      message_id: messageId,
      embedding: embedding,
    }, { onConflict: 'message_id' })

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

/**
 * Get conversations with embeddings where a specific CP is a participant.
 * Used for semantic similarity matching — only returns active conversations
 * that already have an embedding vector stored.
 */
export async function getConversationsWithEmbeddingsByCP(
  userId: string,
  cpId: string
): Promise<{ id: string; embedding: number[] }[]> {
  const supabase = getSupabaseAdmin()

  // Get conversation IDs where this CP is a participant
  const { data: participations, error: partError } = await supabase
    .from('thread_participants')
    .select('thread_id')
    .eq('cp_id', cpId)

  if (partError || !participations || participations.length === 0) {
    return []
  }

  const threadIds = participations.map((p: { thread_id: string }) => p.thread_id)

  // Get those conversations that belong to this user, are active, and have embeddings
  const { data: conversations, error: convError } = await supabase
    .from('conversation_threads')
    .select('id, embedding')
    .eq('user_id', userId)
    .eq('state', 'active')
    .in('id', threadIds)
    .not('embedding', 'is', null)

  if (convError || !conversations) {
    return []
  }

  return conversations
    .filter((c: { id: string; embedding: number[] | null }) => c.embedding !== null)
    .map((c: { id: string; embedding: number[] | null }) => {
      // pgvector may return embedding as a string — handle both formats
      let emb = c.embedding
      if (typeof emb === 'string') {
        emb = JSON.parse(emb)
      }
      return { id: c.id, embedding: emb as number[] }
    })
}
