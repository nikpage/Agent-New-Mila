/**
 * Conversation Threading Service
 * Groups messages into conversations and maintains thread state
 */

import {
  getConversationById,
  createConversation,
  updateConversationSummary,
  incrementMessageCount,
  addParticipant,
  findConversationByExternalThread,
  getRecentMessages,
} from '@/lib/db/conversations'
import { updateMessage, getMessageById } from '@/lib/db/messages'
import { getCPById } from '@/lib/db/counterparties'
import { analyzeConversation, extractTopic, shouldJoinConversation } from '@/lib/ai/gemini'
import { generateConversationEmbedding, generateMessageEmbedding } from '@/lib/embeddings/generate'
import { saveConversationEmbedding, getConversationsWithEmbeddingsByCP } from '@/lib/db/embeddings'
import type { Message, ConversationThread } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

const MESSAGES_BEFORE_REBUILD = 5 // Rebuild summary after this many new messages
const SIMILARITY_THRESHOLD = 0.78 // Cosine similarity — auto-join above this
const TIEBREAKER_THRESHOLD = 0.55 // Cosine similarity — ask AI to decide between this and SIMILARITY_THRESHOLD

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 = identical.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Assign a message to a conversation (existing or new)
 */
export async function assignToConversation(
  message: Message
): Promise<ConversationThread> {
  // First, try to find by external thread ID (Gmail thread)
  if (message.external_thread_id) {
    const existingConversation = await findConversationByExternalThread(
      message.user_id,
      message.external_thread_id
    )

    if (existingConversation) {
      // Assign message to existing conversation
      await updateMessage(message.id, { conversation_id: existingConversation.id })
      await incrementMessageCount(existingConversation.id)

      // Add participant if not already
      if (message.cp_id) {
        await addParticipant(existingConversation.id, message.cp_id)
      }

      // Check if we need to rebuild the summary
      const updatedConversation = await getConversationById(existingConversation.id)
      if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
        await rebuildConversationSummary(updatedConversation)
      }

      return (await getConversationById(existingConversation.id))!
    }
  }

  // Step 2: Try embedding similarity — only match conversations where the same CP
  // is already a participant. A new CP with similar content gets a new conversation;
  // new CPs join existing conversations only via Gmail thread ID (CC, reply-all).
  if (message.cp_id) {
    try {
      const messageText = message.cleaned_text || message.raw_text || ''
      if (messageText.length > 0) {
        const messageEmbedding = await generateMessageEmbedding(messageText)

        const candidates = await getConversationsWithEmbeddingsByCP(
          message.user_id,
          message.cp_id
        )

        // Find the single best candidate by similarity
        let bestCandidate: { id: string; similarity: number } | null = null
        for (const candidate of candidates) {
          const similarity = cosineSimilarity(messageEmbedding, candidate.embedding)
          if (!bestCandidate || similarity > bestCandidate.similarity) {
            bestCandidate = { id: candidate.id, similarity }
          }
        }

        // Two-tier decision: auto-join if high confidence, ask AI if uncertain
        let shouldJoin = false

        if (bestCandidate && bestCandidate.similarity >= SIMILARITY_THRESHOLD) {
          // Tier 1: High confidence — auto-join
          shouldJoin = true

        } else if (bestCandidate && bestCandidate.similarity >= TIEBREAKER_THRESHOLD) {
          // Tier 2: Uncertain range — ask shouldJoinConversation AI tiebreaker
          try {
            const candidateConversation = await getConversationById(bestCandidate.id)
            const cp = await getCPById(message.cp_id)
            const cpName = cp?.name || cp?.primary_identifier || 'Unknown'

            if (candidateConversation) {
              shouldJoin = await shouldJoinConversation(
                {
                  subject: '',
                  body: messageText,
                  from: cpName,
                },
                {
                  topic: candidateConversation.topic || '',
                  summary: candidateConversation.summary_text || '',
                  participants: [cpName],
                }
              )
            }
          } catch (tiebreakError) {
            console.error('[Threading] AI tiebreaker failed:', tiebreakError)
          }
        }

        if (shouldJoin && bestCandidate) {
          console.log(`[Threading] Joined conversation ${bestCandidate.id} (similarity: ${bestCandidate.similarity.toFixed(3)})`)
          await updateMessage(message.id, { conversation_id: bestCandidate.id })
          await incrementMessageCount(bestCandidate.id)

          if (message.cp_id) {
            await addParticipant(bestCandidate.id, message.cp_id)
          }

          const updatedConversation = await getConversationById(bestCandidate.id)
          if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
            await rebuildConversationSummary(updatedConversation)
          }

          return (await getConversationById(bestCandidate.id))!
        }
      }
    } catch (error) {
      console.error('[Threading] Embedding similarity check failed:', error)
    }
  }

  // Step 3: Create a new conversation — no external thread match, no embedding match
  const topic = await extractTopicFromMessage(message)

  const conversation = await createConversation({
    user_id: message.user_id,
    topic,
    state: 'active',
  })

  // Assign message to the new conversation
  await updateMessage(message.id, { conversation_id: conversation.id })

  // Add participant
  if (message.cp_id) {
    await addParticipant(conversation.id, message.cp_id)
  }

  // Generate initial summary
  await rebuildConversationSummary(conversation)

  return (await getConversationById(conversation.id))!
}

/**
 * Extract topic from a message
 */
async function extractTopicFromMessage(message: Message): Promise<string> {
  const text = message.cleaned_text || message.raw_text || ''

  if (text.length < 50) {
    return text.slice(0, 100) || 'New conversation'
  }

  try {
    return await extractTopic([{ text }])
  } catch (error) {
    console.error('Failed to extract topic:', error)
    return text.slice(0, 100) || 'New conversation'
  }
}

/**
 * Check if we should rebuild the conversation summary
 */
function shouldRebuildSummary(conversation: ConversationThread): boolean {
  return (conversation.messages_since_rebuild || 0) >= MESSAGES_BEFORE_REBUILD
}

/**
 * Rebuild the conversation summary using AI
 */
export async function rebuildConversationSummary(
  conversation: ConversationThread
): Promise<void> {
  // Get all messages in the conversation
  const messages = await getRecentMessages(conversation.id, 20)

  if (messages.length === 0) {
    return
  }

  // Format messages for analysis
  const formattedMessages = messages.map(m => ({
    direction: m.direction || 'UNKNOWN',
    text: m.cleaned_text || m.raw_text || '',
    date: new Date(m.timestamp),
  }))

  // Generate and save conversation embedding — independent of summary analysis
  // so that embedding-based conversation matching works even if the AI summary fails.
  try {
    const messageTexts = formattedMessages.map(m => m.text)
    const embedding = await generateConversationEmbedding(messageTexts)
    await saveConversationEmbedding(conversation.id, embedding)
  } catch (embeddingError) {
    console.error(`[Threading] Failed to generate embedding for conversation ${conversation.id}:`, embeddingError)
  }

  // Generate AI summary — separate try/catch so embedding is not blocked by this
  try {
    const summary = await analyzeConversation(formattedMessages)

    // Generate a text summary
    const summaryText = `${summary.currentState}. ${summary.nextSteps.length > 0 ? 'Next: ' + summary.nextSteps[0] : ''}`

    await updateConversationSummary(
      conversation.id,
      summary,
      summaryText,
      0.8, // confidence
      'AI analysis'
    )
  } catch (error) {
    console.error('[Threading] Failed to rebuild conversation summary:', error)
  }
}

/**
 * Process multiple messages and assign them to conversations
 */
export async function processMessagesForThreading(
  messages: Message[]
): Promise<Map<string, ConversationThread>> {
  const conversations = new Map<string, ConversationThread>()

  for (const message of messages) {
    if (message.conversation_id) {
      // Already assigned
      const conv = await getConversationById(message.conversation_id)
      if (conv) {
        conversations.set(conv.id, conv)
      }
      continue
    }

    const conversation = await assignToConversation(message)
    conversations.set(conversation.id, conversation)
  }

  return conversations
}

/**
 * Get conversation with full context
 */
export async function getConversationContext(conversationId: string): Promise<{
  conversation: ConversationThread
  messages: Message[]
  participants: string[]
} | null> {
  const conversation = await getConversationById(conversationId)
  if (!conversation) return null

  const messages = await getRecentMessages(conversationId, 50)

  // Get unique participant CPs
  const cpIds = new Set<string>()
  for (const msg of messages) {
    if (msg.cp_id) cpIds.add(msg.cp_id)
  }

  const participants: string[] = []
  for (const cpId of cpIds) {
    const cp = await getCPById(cpId)
    if (cp) {
      participants.push(cp.name || cp.primary_identifier)
    }
  }

  return { conversation, messages, participants }
}
