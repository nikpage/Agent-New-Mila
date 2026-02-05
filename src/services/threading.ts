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
import { analyzeConversation, extractTopic } from '@/lib/ai/gemini'
import { generateConversationEmbedding } from '@/lib/embeddings/generate'
import { saveConversationEmbedding } from '@/lib/db/embeddings'
import type { Message, ConversationThread } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

const MESSAGES_BEFORE_REBUILD = 5 // Rebuild summary after this many new messages

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

  // Create a new conversation
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

    // Generate and save conversation embedding
    try {
      const messageTexts = formattedMessages.map(m => m.text)
      const embedding = await generateConversationEmbedding(messageTexts)
      await saveConversationEmbedding(conversation.id, embedding)
    } catch (embeddingError) {
      console.error(`Failed to generate embedding for conversation ${conversation.id}:`, embeddingError)
    }
  } catch (error) {
    console.error('Failed to rebuild conversation summary:', error)
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
