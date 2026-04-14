/**
 * Conversation Threading Service
 * Groups timeline entries into conversations and maintains thread state.
 *
 * V2: Timeline-based assignment replaces embedding-based matching.
 * Algorithm: external thread ID -> CP conversation count -> density heuristic -> AI assignment.
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
import { analyzeConversation, extractTopic, shouldJoinConversation } from '@/lib/ai/tasks'
import { getJournalEntriesForContext } from '@/lib/db/journal'
import { formatJournalForPrompt } from '@/lib/ai/context'
import { runAITask } from '@/lib/ai/runner'
import { generateConversationEmbedding, generateMessageEmbedding } from '@/lib/embeddings/generate'
import { saveConversationEmbedding } from '@/lib/db/embeddings'
import { assignTimelineEntry, getRecentDensityByConversation, getTimelineContextForConversations } from '@/lib/db/timeline'
import { createTodo } from '@/lib/db/todos'
import { getUserSettings } from '@/lib/db/users'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { validateDealType } from '@/shared/deal-types'
import type { Message, ConversationThread, DealTimelineEntry } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

const MESSAGES_BEFORE_REBUILD = 5 // Rebuild summary after this many new messages
/** @internal -- exported for pinning tests */
export const SIMILARITY_THRESHOLD = 0.78 // Cosine similarity -- auto-join above this
/** @internal -- exported for pinning tests */
export const TIEBREAKER_THRESHOLD = 0.55 // Cosine similarity -- ask AI to decide between this and SIMILARITY_THRESHOLD

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 = identical.
 * @internal -- exported for pinning tests
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
 * Assign a timeline entry to a conversation (existing or new).
 *
 * Algorithm:
 *   1. External thread ID match (fast path via message_id lookup)
 *   2. CP active conversation count: 0 = create, 1 = assign, 2+ = heuristic/AI
 *   3. Density/recency heuristic (burst detection)
 *   4. AI assignment across candidate conversations
 *   5. Writeback to deal_timeline + messages
 */
export async function assignToConversation(
  entry: DealTimelineEntry
): Promise<ConversationThread> {
  // ---- Step 1: External thread ID match (fast path) ----
  if (entry.message_id) {
    try {
      const message = await getMessageById(entry.message_id)
      if (message?.external_thread_id) {
        const existingConversation = await findConversationByExternalThread(
          entry.user_id,
          message.external_thread_id
        )

        if (existingConversation) {
          await writebackAssignment(entry, existingConversation.id)

          const updatedConversation = await getConversationById(existingConversation.id)
          if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
            await rebuildConversationSummary(updatedConversation)
          }

          return (await getConversationById(existingConversation.id))!
        }
      }
    } catch (error) {
      console.error(`[Threading] External thread ID lookup failed for entry ${entry.id}:`, error)
    }
  }

  // ---- Step 2: Count active conversations for this CP ----
  const cpConversationIds = await getActiveCpConversationIds(entry.user_id, entry.cp_id)

  if (cpConversationIds.length === 0) {
    // No existing conversations -- create new
    return await createNewConversationFromEntry(entry)
  }

  if (cpConversationIds.length === 1) {
    // Exactly one conversation -- assign directly
    const conversationId = cpConversationIds[0]
    await writebackAssignment(entry, conversationId)

    const updatedConversation = await getConversationById(conversationId)
    if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
      await rebuildConversationSummary(updatedConversation)
    }

    return (await getConversationById(conversationId))!
  }

  // ---- Step 3: Density/recency heuristic ----
  try {
    const densityMap = await getRecentDensityByConversation(
      entry.user_id,
      entry.cp_id,
      cpConversationIds,
      15 // 15-minute window
    )

    if (densityMap.size > 0) {
      // Sort by count descending
      const sorted = Array.from(densityMap.entries()).sort((a, b) => b[1] - a[1])
      const topCount = sorted[0][1]
      const nextCount = sorted.length > 1 ? sorted[1][1] : 0

      if (topCount >= 3 && nextCount === 0) {
        // Clear winner -- burst of activity in one conversation
        const conversationId = sorted[0][0]
        await writebackAssignment(entry, conversationId)

        const updatedConversation = await getConversationById(conversationId)
        if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
          await rebuildConversationSummary(updatedConversation)
        }

        return (await getConversationById(conversationId))!
      }
    }
  } catch (error) {
    console.error(`[Threading] Density heuristic failed for entry ${entry.id}:`, error)
  }

  // ---- Step 4: AI assignment ----
  try {
    const contextMap = await getTimelineContextForConversations(cpConversationIds, 10)

    // Fetch conversation metadata for topics
    const conversations = await Promise.all(
      cpConversationIds.map(id => getConversationById(id))
    )
    const validConversations = conversations.filter(
      (c): c is ConversationThread => c !== null
    )

    if (validConversations.length > 0) {
      // Build prompt
      const entryPreview = (entry.content || '').slice(0, 500)
      const candidateLines = validConversations.map(conv => {
        const entries = contextMap.get(conv.id) || []
        const entryTexts = entries
          .map(e => `  [${e.event_type}] [${e.direction}] ${e.occurred_at}: ${(e.content || '').slice(0, 200)}`)
          .join('\n')
        return `--- Conversation ${conv.id}: "${conv.topic || 'No topic'}" ---\n${entryTexts || '  (no recent activity)'}`
      }).join('\n\n')

      const prompt = `You are assigning a new event to the correct conversation for a real estate professional.

NEW EVENT: [${entry.event_type}] [${entry.direction}] ${entry.occurred_at}: ${entryPreview}

CANDIDATE CONVERSATIONS:
${candidateLines}

Which conversation does this event belong to? If it clearly belongs to one of the existing conversations, respond with ONLY the conversation ID (the UUID). If it does not belong to any existing conversation, respond with ONLY "NEW".`

      const aiResponse = await runAITask('threading', prompt)
      const trimmed = aiResponse.trim()

      // Check if AI returned a valid conversation ID
      const matchedConversation = validConversations.find(c => trimmed.includes(c.id))
      if (matchedConversation) {
        await writebackAssignment(entry, matchedConversation.id)

        const updatedConversation = await getConversationById(matchedConversation.id)
        if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
          await rebuildConversationSummary(updatedConversation)
        }

        return (await getConversationById(matchedConversation.id))!
      }

      // AI said NEW or returned something unrecognizable -- fall through to create
    }
  } catch (error) {
    console.error(`[Threading] AI assignment failed for entry ${entry.id}:`, error)
  }

  // ---- Fallback: Create new conversation ----
  return await createNewConversationFromEntry(entry)
}

/**
 * Get active conversation IDs where a specific CP is a participant.
 */
async function getActiveCpConversationIds(
  userId: string,
  cpId: string
): Promise<string[]> {
  const supabase = getSupabaseAdmin()

  const { data: participants } = await supabase
    .from('thread_participants')
    .select('thread_id')
    .eq('cp_id', cpId)

  if (!participants || participants.length === 0) return []

  const threadIds = participants.map(p => p.thread_id)

  const { data: activeThreads } = await supabase
    .from('conversation_threads')
    .select('id')
    .eq('user_id', userId)
    .in('id', threadIds)
    .eq('state', 'active')

  return (activeThreads || []).map(t => t.id)
}

/**
 * Create a new conversation from a timeline entry.
 * Includes topic extraction, thin-conversation check, and initial summary.
 */
async function createNewConversationFromEntry(
  entry: DealTimelineEntry
): Promise<ConversationThread> {
  const topic = await extractTopicFromTimelineEntry(entry)

  const conversation = await createConversation({
    user_id: entry.user_id,
    topic,
    state: 'active',
  })

  await writebackAssignment(entry, conversation.id)

  // Generate initial summary
  await rebuildConversationSummary(conversation)

  // Thin conversation check: if content is very short, create a ToDo asking
  // for context. Only fires when content exists but has almost nothing.
  const THIN_CONVERSATION_THRESHOLD = 100
  const entryContent = entry.content || ''
  if (entryContent.length > 0 && entryContent.length < THIN_CONVERSATION_THRESHOLD && entry.cp_id) {
    try {
      const cp = await getCPById(entry.cp_id)
      const cpName = cp?.name || cp?.primary_identifier || 'unknown contact'
      await createTodo({
        user_id: entry.user_id,
        cp_id: entry.cp_id,
        thread_id: conversation.id,
        description: `New conversation with ${cpName} -- insufficient context. What is this about?`,
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
 * Write conversation assignment back to timeline entry and optionally to message.
 * Also increments message count and adds CP as participant.
 */
async function writebackAssignment(
  entry: DealTimelineEntry,
  conversationId: string
): Promise<void> {
  // Write to deal_timeline
  await assignTimelineEntry(entry.id, conversationId)

  // If linked to a message, also write to messages table
  if (entry.message_id) {
    await updateMessage(entry.message_id, { conversation_id: conversationId })
  }

  // Increment message count + add participant
  await incrementMessageCount(conversationId)
  if (entry.cp_id) {
    await addParticipant(conversationId, entry.cp_id)
  }
}

/**
 * Extract topic from a timeline entry's content.
 */
async function extractTopicFromTimelineEntry(entry: DealTimelineEntry): Promise<string> {
  const text = entry.content || ''

  if (text.length < 50) {
    return text.slice(0, 100) || 'New conversation'
  }

  try {
    return await extractTopic([{ text }])
  } catch (error) {
    console.error('Failed to extract topic from timeline entry:', error)
    return text.slice(0, 100) || 'New conversation'
  }
}

/**
 * Extract topic from a message (legacy helper, used by _legacyProcessMessagesForThreading)
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
  // Fetch more messages than we may need -- adaptive selection below
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

  // Fetch journal beliefs for this conversation — enriches summary with accumulated knowledge
  let journalNotes: string | undefined
  try {
    const journal = await getJournalEntriesForContext(conversation.user_id, [conversation.id], [])
    journalNotes = formatJournalForPrompt(journal) || undefined
  } catch { /* journal fetch failed — proceed without */ }

  // Step 1: Generate AI summary
  let summaryText: string | null = null
  try {
    const summary = await analyzeConversation(selectedMessages, settings ?? undefined, journalNotes)

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
 * Process timeline entries and assign them to conversations.
 * Replaces processMessagesForThreading for the timeline-based pipeline.
 *
 * Pre-assigned entries (conversation_id already set) -> batch fetch conversations.
 * Unassigned entries -> serial via assignToConversation (prevents duplicate creation).
 */
export async function processTimelineEntries(
  entries: DealTimelineEntry[]
): Promise<Map<string, ConversationThread>> {
  const conversations = new Map<string, ConversationThread>()

  // Separate pre-assigned entries from unassigned
  const preAssigned = entries.filter(e => e.conversation_id)
  const unassigned = entries.filter(e => !e.conversation_id)

  // Batch-fetch pre-assigned conversations in parallel
  if (preAssigned.length > 0) {
    const convResults = await Promise.allSettled(
      preAssigned.map(e => getConversationById(e.conversation_id!))
    )
    for (const result of convResults) {
      if (result.status === 'fulfilled' && result.value) {
        conversations.set(result.value.id, result.value)
      }
    }
  }

  // Process unassigned entries serially (assignToConversation may create
  // new conversations, so parallel processing could produce duplicates)
  for (const entry of unassigned) {
    const conversation = await assignToConversation(entry)
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

  // Get unique participant CPs -- fetch in parallel
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

// ============================================================
// Legacy function -- kept for backward compatibility with bulk
// ingestion and callers not yet migrated to timeline entries.
// ============================================================

/**
 * @deprecated Alias for backward compatibility. Use processTimelineEntries instead.
 */
export const processMessagesForThreading = _legacyProcessMessagesForThreading

/**
 * @deprecated Use processTimelineEntries instead.
 * Legacy embedding-based message threading.
 */
async function _legacyProcessMessagesForThreading(
  messages: Message[]
): Promise<Map<string, ConversationThread>> {
  const conversations = new Map<string, ConversationThread>()

  const preAssigned = messages.filter(m => m.conversation_id)
  const unassigned = messages.filter(m => !m.conversation_id)

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

  for (const message of unassigned) {
    const conversation = await _legacyAssignToConversation(message)
    conversations.set(conversation.id, conversation)
  }

  return conversations
}

/**
 * @deprecated Legacy embedding-based assignment. Kept for _legacyProcessMessagesForThreading.
 */
async function _legacyAssignToConversation(
  message: Message
): Promise<ConversationThread> {
  // Import dynamically to avoid top-level import of removed function
  const { getConversationsWithEmbeddingsByCP } = await import('@/lib/db/embeddings')

  if (message.external_thread_id) {
    const existingConversation = await findConversationByExternalThread(
      message.user_id,
      message.external_thread_id
    )

    if (existingConversation) {
      await updateMessage(message.id, { conversation_id: existingConversation.id })
      await incrementMessageCount(existingConversation.id)

      if (message.cp_id) {
        await addParticipant(existingConversation.id, message.cp_id)
      }

      const updatedConversation = await getConversationById(existingConversation.id)
      if (updatedConversation && shouldRebuildSummary(updatedConversation)) {
        await rebuildConversationSummary(updatedConversation)
      }

      return (await getConversationById(existingConversation.id))!
    }
  }

  if (message.cp_id) {
    try {
      const hasEnrichedText = !!message.enriched_text
      const messageText = message.enriched_text || message.cleaned_text || message.raw_text || ''
      if (messageText.length > 0) {
        const messageEmbedding = await generateMessageEmbedding(
          messageText,
          'email',
          hasEnrichedText
        )

        const candidates = await getConversationsWithEmbeddingsByCP(
          message.user_id,
          message.cp_id
        )

        let bestCandidate: { id: string; similarity: number } | null = null
        for (const candidate of candidates) {
          const similarity = cosineSimilarity(messageEmbedding, candidate.embedding)
          if (!bestCandidate || similarity > bestCandidate.similarity) {
            bestCandidate = { id: candidate.id, similarity }
          }
        }

        let shouldJoin = false

        if (bestCandidate && bestCandidate.similarity >= SIMILARITY_THRESHOLD) {
          shouldJoin = true
        } else if (bestCandidate && bestCandidate.similarity >= TIEBREAKER_THRESHOLD) {
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
      console.error(`[Embeddings] FAILED during threading for message ${message.id} (cp: ${message.cp_id}):`, error)
    }
  }

  const topic = await extractTopicFromMessage(message)

  const conversation = await createConversation({
    user_id: message.user_id,
    topic,
    state: 'active',
  })

  await updateMessage(message.id, { conversation_id: conversation.id })
  await incrementMessageCount(conversation.id)

  if (message.cp_id) {
    await addParticipant(conversation.id, message.cp_id)
  }

  await rebuildConversationSummary(conversation)

  const THIN_CONVERSATION_THRESHOLD = 100
  const isBulkImport = message.tag_primary === 'bulk_import'
  if (!isBulkImport && message.enriched_text && message.enriched_text.length < THIN_CONVERSATION_THRESHOLD && message.cp_id) {
    try {
      const cp = await getCPById(message.cp_id)
      const cpName = cp?.name || cp?.primary_identifier || 'unknown contact'
      await createTodo({
        user_id: message.user_id,
        cp_id: message.cp_id,
        thread_id: conversation.id,
        description: `New conversation with ${cpName} -- insufficient context. What is this about?`,
        status: 'pending',
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
    } catch (todoError) {
      console.error('[Threading] Failed to create thin-conversation ToDo:', todoError)
    }
  }

  return (await getConversationById(conversation.id))!
}
