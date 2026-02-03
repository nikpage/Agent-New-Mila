/**
 * Action Planning Service
 * Analyzes conversations and generates action proposals
 */

import { proposeAction, generateDraftReply } from '@/lib/ai/gemini'
import {
  createAction,
  hasPendingAction,
  calculatePriorityScore,
} from '@/lib/db/actions'
import { getConversationById, getRecentMessages } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import type {
  ActionProposal,
  ConversationThread,
  ConversationSummary,
} from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

/**
 * Generate an action proposal for a conversation
 */
export async function generateActionProposal(
  conversation: ConversationThread
): Promise<ActionProposal | null> {
  // Check if there's already a pending action
  if (await hasPendingAction(conversation.id)) {
    return null
  }

  // Get conversation summary
  const summary = conversation.summary_json as ConversationSummary | null
  if (!summary) {
    return null
  }

  // Get recent messages
  const recentMessages = await getRecentMessages(conversation.id, 5)
  if (recentMessages.length === 0) {
    return null
  }

  // Get the primary CP (most recent message sender)
  const latestInbound = recentMessages
    .filter(m => m.direction === 'INBOUND' && m.cp_id)
    .pop()

  if (!latestInbound?.cp_id) {
    return null
  }

  const cp = await getCPById(latestInbound.cp_id)
  if (!cp || cp.is_blacklisted) {
    return null
  }

  // Format messages for AI
  const formattedMessages = recentMessages.map(m => ({
    direction: m.direction || 'UNKNOWN',
    text: m.cleaned_text || m.raw_text || '',
  }))

  try {
    // Get AI recommendation
    const proposal = await proposeAction(summary, formattedMessages, cp.name)

    // Skip if action is WAIT (nothing to do)
    if (proposal.actionType === 'WAIT') {
      return null
    }

    // Calculate days since last activity
    const lastUpdate = conversation.last_updated
      ? new Date(conversation.last_updated)
      : new Date()
    const daysIgnored = Math.floor(
      (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24)
    )

    // Calculate priority score
    const priorityScore = calculatePriorityScore({
      dollarValue: proposal.dollarValue,
      urgency: proposal.urgency,
      painFactor: proposal.painFactor,
      daysIgnored,
    })

    // Create the action proposal
    const action = await createAction({
      id: uuidv4(),
      user_id: conversation.user_id,
      conversation_id: conversation.id,
      cp_id: cp.id,
      action_type: proposal.actionType,
      rationale: proposal.rationale,
      draft_subject: proposal.draftSubject || null,
      draft_body_text: proposal.draftBody || null,
      priority_score: priorityScore,
      dollar_value: proposal.dollarValue,
      urgency: proposal.urgency,
      pain_factor: proposal.painFactor,
      payload: { original_proposal: proposal },
      queued_for_brief: true,
    })

    return action
  } catch (error) {
    console.error('Failed to generate action proposal:', error)
    return null
  }
}

/**
 * Process multiple conversations and generate action proposals
 */
export async function generateActionsForConversations(
  conversationIds: string[]
): Promise<ActionProposal[]> {
  const actions: ActionProposal[] = []

  for (const convId of conversationIds) {
    const conversation = await getConversationById(convId)
    if (!conversation) continue

    const action = await generateActionProposal(conversation)
    if (action) {
      actions.push(action)
    }
  }

  return actions
}

/**
 * Regenerate draft for an action with user feedback
 */
export async function regenerateDraft(
  actionId: string,
  userIntent: string
): Promise<{ subject: string; body: string }> {
  // This would get the action, conversation context, and regenerate
  // For now, return a placeholder
  return generateDraftReply(
    'Conversation context here',
    userIntent,
    null
  )
}
