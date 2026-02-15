import { proposeAction, generateFinalDraft } from '@/lib/ai/gemini'
import {
  createAction,
  calculatePriorityScore,
} from '@/lib/db/actions'
import { getConversationById, getRecentMessages } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getUserSettings } from '@/lib/db/users'
import { proposeMeeting } from './scheduling'
import type {
  ActionProposal,
  ConversationThread,
  ConversationSummary,
} from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

export async function generateActionProposal(
  conversation: ConversationThread
): Promise<ActionProposal | null> {
  const summary = conversation.summary_json as unknown as ConversationSummary

  const recentMessages = await getRecentMessages(conversation.id, 5)

  // Find CP from latest message — support both inbound AND outbound
  // Outbound: user sent an email to CP (e.g., proposing a meeting)
  // Inbound: CP sent an email to user
  const latestWithCP = recentMessages
    .filter(m => m.cp_id)
    .pop()

  if (!latestWithCP?.cp_id) return null

  const cp = await getCPById(latestWithCP.cp_id)
  if (!cp || cp.is_blacklisted) return null

  // Detect channel from most recent message
  const lastMessage = recentMessages[recentMessages.length - 1]
  const channel: 'email' | 'whatsapp' = lastMessage?.channel_id === 'whatsapp' ? 'whatsapp' : 'email'

  const formattedMessages = recentMessages.map(m => ({
    direction: m.direction || 'UNKNOWN',
    text: m.cleaned_text || m.raw_text || '',
  }))

  try {
    // Get user settings for AI context
    const settings = await getUserSettings(conversation.user_id)

    // Get AI recommendation (Intent Only)
    const proposal = await proposeAction(summary, formattedMessages, cp.name, settings, channel)

    // Proactive Calendar: If SCHEDULE action, use full scheduling service
    // Mila acts as a human assistant - finds best slots, blocks them IN USER'S CALENDAR ONLY,
    // prepares everything for user to approve. User approves → Mila sends EMAIL to CP with options.
    // Calendar blocks are USER-ONLY. CP gets options via email, never calendar holds.
    let schedulingPayload: Record<string, unknown> = {}
    if (proposal.actionType === 'SCHEDULE') {
      try {
        const cpName = cp.name || cp.primary_identifier

        // Extract meeting location from: AI suggestion, CP's known locations, or null
        let meetingLocation: string | undefined
        if (proposal.suggestedLocation) {
          meetingLocation = proposal.suggestedLocation
        } else if (cp.locations) {
          const locations = cp.locations as unknown
          if (Array.isArray(locations) && locations.length > 0 && typeof locations[0] === 'string') {
            meetingLocation = locations[0]
          } else if (typeof locations === 'string') {
            meetingLocation = locations
          }
        }

        // Extract preferred date if CP or user proposed a specific time
        let preferredDate: Date | undefined
        if (proposal.suggestedTime) {
          try {
            preferredDate = new Date(proposal.suggestedTime)
            if (isNaN(preferredDate.getTime())) {
              preferredDate = undefined
            }
          } catch {
            preferredDate = undefined
          }
        }

        // Single call: find best slots, check conflicts, block them in user's calendar
        const schedulingResult = await proposeMeeting(
          conversation.user_id,
          cp.id,
          settings.default_meeting_duration,
          meetingLocation,
          preferredDate
        )

        if (schedulingResult.success && schedulingResult.blockedSlots && schedulingResult.blockedSlots.length > 0) {
          // Format blocked slots for proactive display to USER
          const formattedSlots = schedulingResult.blockedSlots.map((s, i) => {
            const start = new Date(s.start_time)
            const end = new Date(s.end_time)
            const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })
            const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
            const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
            return `${i + 1}. ${dateStr}, ${startStr} - ${endStr}`
          })

          // Proactive intent: tell user what Mila DID (blocked slots) and what she WILL DO (send email)
          proposal.intent_cs = `Připravila jsem ${formattedSlots.length} termíny pro schůzku s ${cpName} a zablokovala je ve vašem kalendáři:\n${formattedSlots.join('\n')}${meetingLocation ? `\nMísto: ${meetingLocation}` : ''}\n\nKlikněte na UDĚLAT a já odešlu ${cpName} email s nabídkou těchto termínů.`

          // No missingInfo needed for approval - UDĚLAT button IS the approval
          // User can add notes via UPRAVIT if needed
          proposal.missingInfo = []

          // Conflict info for user (if any)
          if (schedulingResult.conflicts && schedulingResult.conflicts.length > 0) {
            const conflictNote = schedulingResult.conflicts.map(c =>
              `${c.existingEvent.title}: ${c.recommendation === 'move_existing' ? 'navrhuji přesunout' : 'navrhuji alternativní čas'}`
            ).join('; ')
            proposal.intent_cs += `\n\nKonflikty: ${conflictNote}`
          }

          schedulingPayload = {
            pre_block_group_id: schedulingResult.preBlockGroupId,
            blocked_slots: schedulingResult.blockedSlots.map((s, i) => ({
              id: s.id,
              gcal_event_id: schedulingResult.gcalEventIds?.[i],
              start: s.start_time,
              end: s.end_time,
              location: s.location,
            })),
            location: meetingLocation || null,
            conflicts: schedulingResult.conflicts?.map(c => ({
              event_title: c.existingEvent.title,
              recommendation: c.recommendation,
            })),
          }
        } else {
          // Scheduling failed or no slots found - fall back to manual
          proposal.missingInfo.push({
            label: schedulingResult.error || 'V nejbližších 14 dnech nejsou volné termíny v pracovní době. Napište preferovaný čas.',
            value: null,
          })
        }
      } catch (calendarError) {
        console.error('Failed to run scheduling service:', calendarError)
        // Continue without calendar - user can enter time manually
        proposal.missingInfo.push({
          label: 'Kdy byste chtěl/a se sejít? (Napište preferovaný čas)',
          value: null,
        })
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
        channel,
        action_metadata: {
          action_type: proposal.actionType,
          urgency: proposal.urgency,
          dollar_value: proposal.dollarValue,
          pain_factor: proposal.painFactor,
        },
        ...schedulingPayload,
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
