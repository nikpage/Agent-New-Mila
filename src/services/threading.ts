/**
 * Conversation Threading Service
 * Groups messages into conversations and maintains thread state
 */

import {
  getConversationById,
  createConversation,
  updateConversation,
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
import { createTodo } from '@/lib/db/todos'
import { getUserSettings } from '@/lib/db/users'
import { validateDealType } from './planning'
import type { Message, ConversationThread } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

const MESSAGES_BEFORE_REBUILD = 5 // Rebuild summary after this many new messages
/** @internal — exported for pinning tests */
export const SIMILARITY_THRESHOLD = 0.78 // Cosine similarity — auto-join above this
/** @internal — exported for pinning tests */
export const TIEBREAKER_THRESHOLD = 0.55 // Cosine similarity — ask AI to decide between this and SIMILARITY_THRESHOLD

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 = identical.
 * @internal — exported for pinning tests
 */
export function cosineSimilarity(a: number[], b: number[]): number {
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
      const messageText = message.enriched_text || message.cleaned_text || message.raw_text || ''
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

  // Thin conversation check: if the first message has enriched_text but it's
  // very short, create a ToDo asking the user for context. Only fires when
  // enrichment actually ran (enriched_text is non-null) but extracted almost
  // nothing. Null enriched_text = not yet enriched, NOT thin.
  // Skip for bulk_import messages — bulk historical import shouldn't flood todos.
  const THIN_CONVERSATION_THRESHOLD = 100
  const isBulkImport = message.tag_primary === 'bulk_import'
  if (!isBulkImport && message.enriched_text && message.enriched_text.length < THIN_CONVERSATION_THRESHOLD && message.cp_id) {
    try {
      const cp = await getCPById(message.cp_id)
      const cpName = cp?.name || cp?.primary_identifier || 'neznámý kontakt'
      await createTodo({
        user_id: message.user_id,
        cp_id: message.cp_id,
        thread_id: conversation.id,
        description: `Nová konverzace s ${cpName} — nedostatek kontextu. O čem se jedná?`,
        status: 'pending',
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
    } catch (todoError) {
      console.error('[Threading] Failed to create thin-conversation ToDo:', todoError)
    }
  }

  return (await getConversationById(conversation.id))!
}

/**
 * Extract topic from a message
 */
async function extractTopicFromMessage(message: Message): Promise<string> {
  const text = message.cleaned_text || message.raw_text || ''

  if (text.length < 50) {
    return text.slice(0, 100) || 'Nová konverzace'
  }

  try {
    return await extractTopic([{ text }])
  } catch (error) {
    console.error('Failed to extract topic:', error)
    return text.slice(0, 100) || 'Nová konverzace'
  }
}

/**
 * Check if we should rebuild the conversation summary
 */
function shouldRebuildSummary(conversation: ConversationThread): boolean {
  return (conversation.messages_since_rebuild || 0) >= MESSAGES_BEFORE_REBUILD
}

/**
 * Rebuild the conversation summary using AI, then embed the summary.
 *
 * Uses enriched_text when available (pre-extracted facts), falls back to
 * cleaned_text for older messages that haven't been enriched yet.
 * Adaptive message count: enough messages to reach ~1500 chars of content.
 *
 * Order: summary first, then embed the summary text (not raw messages).
 */
export async function rebuildConversationSummary(
  conversation: ConversationThread
): Promise<void> {
  // Fetch more messages than we may need — adaptive selection below
  const messages = await getRecentMessages(conversation.id, 20)

  if (messages.length === 0) {
    return
  }

  // Prefer enriched_text (pre-extracted facts), fall back to cleaned_text
  const formattedMessages = messages.map(m => ({
    direction: m.direction || 'UNKNOWN',
    text: m.enriched_text || m.cleaned_text || m.raw_text || '',
    date: new Date(m.timestamp),
  }))

  // Adaptive selection: take enough messages to reach ~1500 chars of content,
  // minimum 3, maximum all fetched. Short enrichments (WhatsApp) naturally
  // include more messages; long enrichments (email) include fewer.
  const MIN_MESSAGES = 3
  const TARGET_CHARS = 1500
  let charCount = 0
  let selectedCount = 0
  for (let i = formattedMessages.length - 1; i >= 0; i--) {
    charCount += formattedMessages[i].text.length
    selectedCount++
    if (charCount >= TARGET_CHARS && selectedCount >= MIN_MESSAGES) break
  }
  selectedCount = Math.max(selectedCount, Math.min(MIN_MESSAGES, formattedMessages.length))
  const selectedMessages = formattedMessages.slice(-selectedCount)

  // Fetch user settings for business context + language in AI summary
  const settings = await getUserSettings(conversation.user_id)

  // Step 1: Generate AI summary
  let summaryText: string | null = null
  try {
    const summary = await analyzeConversation(selectedMessages, settings ?? undefined)

    summaryText = `${summary.currentState}. ${summary.nextSteps.length > 0 ? 'Next: ' + summary.nextSteps[0] : ''}`

    await updateConversationSummary(
      conversation.id,
      summary,
      summaryText,
      summary.confidence ?? 0.5,
      summary.confidenceReason || undefined
    )

    // Set deal_type on the conversation if AI classified it
    const dealType = validateDealType(summary.dealType)
    if (dealType && conversation.deal_type !== dealType) {
      await updateConversation(conversation.id, { deal_type: dealType })
    }
  } catch (error) {
    console.error('[Threading] Failed to rebuild conversation summary:', error)
  }

  // Step 2: Embed the summary (preferred) or message text (fallback).
  try {
    const messageTexts = selectedMessages.map(m => m.text)
    const embedding = await generateConversationEmbedding(messageTexts, summaryText || undefined)
    await saveConversationEmbedding(conversation.id, embedding)
  } catch (embeddingError) {
    console.error(`[Threading] Failed to generate embedding for conversation ${conversation.id}:`, embeddingError)
  }
}

/**
 * Process multiple messages and assign them to conversations
 */
export async function processMessagesForThreading(
  messages: Message[]
): Promise<Map<string, ConversationThread>> {
  const conversations = new Map<string, ConversationThread>()

  // Separate pre-assigned messages (cheap parallel DB lookups) from
  // unassigned messages (must be serial to avoid duplicate conversation creation)
  const preAssigned = messages.filter(m => m.conversation_id)
  const unassigned = messages.filter(m => !m.conversation_id)

  // Batch-fetch pre-assigned conversations in parallel
  if (preAssigned.length > 0) {
    const convResults = await Promise.allSettled(
      preAssigned.map(m => getConversationById(m.conversation_id!))
    )
    for (const result of convResults) {
      if (result.status === 'fulfilled' && result.value) {
        conversations.set(result.value.id, result.value)
      }
    }
  }

  // Process unassigned messages serially (assignToConversation may create
  // new conversations, so parallel processing could produce duplicates)
  for (const message of unassigned) {
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

  // Get unique participant CPs — fetch in parallel
  const cpIds = new Set<string>()
  for (const msg of messages) {
    if (msg.cp_id) cpIds.add(msg.cp_id)
  }

  const cpResults = await Promise.all(
    Array.from(cpIds).map(cpId => getCPById(cpId))
  )
  const participants: string[] = cpResults
    .filter((cp): cp is NonNullable<typeof cp> => cp !== null)
    .map(cp => cp.name || cp.primary_identifier)

  return { conversation, messages, participants }
}
