import { proposeAction, generateFinalDraft } from '@/lib/ai/gemini'
import {
  createAction,
  hasPendingAction,
  calculatePriorityScore,
} from '@/lib/db/actions'
import { getConversationById, getRecentMessages } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { findFreeSlots } from '@/lib/google/calendar'
import type {
  ActionProposal,
  ConversationThread,
  ConversationSummary,
} from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

export async function generateActionProposal(
  conversation: ConversationThread
): Promise<ActionProposal | null> {
  if (await hasPendingAction(conversation.id)) {
    return null
  }

  const summary = conversation.summary_json as ConversationSummary | null
  if (!summary) return null

  const recentMessages = await getRecentMessages(conversation.id, 5)
  if (recentMessages.length === 0) return null

  const latestInbound = recentMessages
    .filter(m => m.direction === 'inbound' && m.cp_id)
    .pop()

  if (!latestInbound?.cp_id) return null

  const cp = await getCPById(latestInbound.cp_id)
  if (!cp || cp.is_blacklisted) return null

  const formattedMessages = recentMessages.map(m => ({
    direction: m.direction || 'UNKNOWN',
    text: m.cleaned_text || m.raw_text || '',
  }))

  try {
    // Get AI recommendation (Intent Only)
    const proposal = await proposeAction(summary, formattedMessages, cp.name)

    if (proposal.actionType === 'WAIT') return null

    // Proactive Calendar: If SCHEDULE action, find free slots and offer them
    if (proposal.actionType === 'SCHEDULE') {
      try {
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        const dayAfter = new Date()
        dayAfter.setDate(dayAfter.getDate() + 2)

        const [tomorrowSlots, dayAfterSlots] = await Promise.all([
          findFreeSlots(conversation.user_id, tomorrow, 60), // 60 min meetings
          findFreeSlots(conversation.user_id, dayAfter, 60)
        ])

        // Format slots as options
        const formatTime = (date: Date) => {
          return date.toLocaleTimeString('cs-CZ', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          })
        }

        const formatDate = (date: Date) => {
          return date.toLocaleDateString('cs-CZ', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          })
        }

        const timeOptions: string[] = []
        tomorrowSlots.slice(0, 3).forEach(slot => {
          timeOptions.push(`${formatDate(slot.start)}, ${formatTime(slot.start)}`)
        })
        dayAfterSlots.slice(0, 2).forEach(slot => {
          timeOptions.push(`${formatDate(slot.start)}, ${formatTime(slot.start)}`)
        })

        if (timeOptions.length > 0) {
          proposal.missingInfo.push({
            label: 'Kdy byste chtěl/a se sejít? (Vyberte jeden z volných termínů nebo napište vlastní)',
            value: null
          })
        }
      } catch (calendarError) {
        console.error('Failed to fetch calendar slots:', calendarError)
        // Continue without calendar - user can enter time manually
      }
    }

    const lastUpdate = conversation.last_updated
      ? new Date(conversation.last_updated)
      : new Date()
    const daysIgnored = Math.floor(
      (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24)
    )

    const priorityScore = calculatePriorityScore({
      dollarValue: proposal.dollarValue,
      urgency: proposal.urgency,
      painFactor: proposal.painFactor,
      daysIgnored,
    })

    // Create the action proposal with CLEAN columns
    const action = await createAction({
      id: uuidv4(),
      user_id: conversation.user_id,
      conversation_id: conversation.id,
      cp_id: cp.id,
      action_type: proposal.actionType,

      // New Columns
      intent_cs: proposal.intent_cs,
      rationale_cs: proposal.rationale_cs,
      missing_info: proposal.missingInfo, // Dynamic form definition

      // Legacy/System columns
      rationale: proposal.rationale_cs, // Keep for backward compat if needed, or use English if you prefer logs in EN
      priority_score: priorityScore,
      dollar_value: proposal.dollarValue,
      urgency: proposal.urgency,
      pain_factor: proposal.painFactor,

      // NO DRAFTS
      draft_subject: null,
      draft_body_text: null,

      payload: {
        intent_cs: proposal.intent_cs,
        execution_plan: proposal.rationale_cs,
        required_inputs: proposal.missingInfo,
        action_metadata: {
          action_type: proposal.actionType,
          urgency: proposal.urgency,
          dollar_value: proposal.dollarValue,
          pain_factor: proposal.painFactor,
        }
      },
      queued_for_brief: true,
    })

    return action
  } catch (error) {
    console.error('Failed to generate action proposal:', error)
    return null
  }
}

export async function generateActionsForConversations(
  conversationIds: string[]
): Promise<ActionProposal[]> {
  const actions: ActionProposal[] = []
  for (const convId of conversationIds) {
    const conversation = await getConversationById(convId)
    if (!conversation) continue
    const action = await generateActionProposal(conversation)
    if (action) actions.push(action)
  }
  return actions
}

export async function regenerateDraft(
  actionId: string,
  userIntent: string
): Promise<{ subject: string; body: string }> {
  return { subject: '', body: '' }
}
