import { NextRequest, NextResponse } from 'next/server'
import { getActionById, completeAction, updateActionDraft } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { validateActionToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/lib/google/gmail'
import { generateFinalDraft } from '@/lib/ai/gemini'
import { confirmSlot, acceptInvitation, declineInvitation } from '@/services/scheduling'
import { createCalendarEvent } from '@/lib/google/calendar'
import { getUserSettings } from '@/lib/db/users'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token } = body

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    // Get the action
    const action = await getActionById(actionId)

    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    // Validate the token
    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    // Check action type and required data
    if (action.action_type === 'REPLY') {
      // Get the CP to get the email address
      const cp = await getCPById(action.cp_id)
      if (!cp) {
        return NextResponse.json({ error: 'Counterparty not found' }, { status: 404 })
      }

      // Generate draft if it doesn't exist
      let draftSubject = action.draft_subject
      let draftBody = action.draft_body_text

      if (!draftBody) {
        const conversation = await getConversationById(action.conversation_id)
        if (!conversation) {
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
        }

        const userNotes = ((action.payload as Record<string, unknown>)?.userNotes as string) || undefined
        const missingInfo = (action.missing_info as { label: string; placeholder: string; value: string | null }[] | null) || undefined

        const draft = await generateFinalDraft(
          conversation.summary_json,
          action.intent_cs || action.rationale_cs || action.rationale,
          userNotes,
          missingInfo,
          cp.name || cp.primary_identifier
        )

        draftSubject = draft.subject
        draftBody = draft.body

        // Save the generated draft
        await updateActionDraft(actionId, draftSubject, draftBody)
      }

      // Use edited recipient if saved, otherwise fall back to CP
      const sendTo = ((action.payload as Record<string, unknown>)?.editedTo as string) || cp.primary_identifier

      // Send the email
      await sendEmail(action.user_id, {
        to: sendTo,
        subject: draftSubject || 'Re: Your message',
        body: draftBody,
      })

      // Mark action as completed
      await completeAction(actionId)

      return NextResponse.json({ success: true, message: 'Email sent' })
    }

    if (action.action_type === 'SCHEDULE') {
      const payload = action.payload as Record<string, unknown>
      const cp = await getCPById(action.cp_id)
      if (!cp) {
        return NextResponse.json({ error: 'Counterparty not found' }, { status: 404 })
      }

      // Case 1: Incoming calendar invitation - accept or decline
      const calendarEventId = payload?.calendar_event_id as string | undefined
      if (calendarEventId) {
        const userResponse = (action.missing_info as { label: string; value: string | null }[] | null)
          ?.[0]?.value?.toLowerCase()

        if (userResponse === 'ano' || userResponse === 'yes' || userResponse === 'přijmout') {
          const result = await acceptInvitation(
            action.user_id,
            calendarEventId,
            payload?.location as string | undefined
          )
          if (!result.success) {
            return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 })
          }
        } else {
          await declineInvitation(action.user_id, calendarEventId)
        }

        await completeAction(actionId)
        return NextResponse.json({ success: true, message: 'Invitation response sent' })
      }

      // Case 2: Pre-blocked slots - user selected one, confirm it
      const preBlockGroupId = payload?.pre_block_group_id as string | undefined
      const blockedSlots = payload?.blocked_slots as { id: string; start: string; end: string }[] | undefined

      if (preBlockGroupId && blockedSlots && blockedSlots.length > 0) {
        // Determine which slot user selected (from missing_info response)
        const userChoice = (action.missing_info as { label: string; value: string | null }[] | null)
          ?.[0]?.value

        // Parse user's selection (1, 2, 3 or a custom time)
        let selectedSlotId: string | undefined
        const choiceNum = parseInt(userChoice || '1', 10)

        if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= blockedSlots.length) {
          selectedSlotId = blockedSlots[choiceNum - 1].id
        } else {
          // Default to first slot if user didn't pick or we can't parse
          selectedSlotId = blockedSlots[0].id
        }

        // Confirm the selected slot and clean up others
        const confirmResult = await confirmSlot(
          action.user_id,
          selectedSlotId,
          preBlockGroupId,
          cp.primary_identifier,
          payload?.location as string | undefined
        )

        // Send email to CP with the confirmed time
        const confirmedEvent = confirmResult.event
        const startTime = new Date(confirmedEvent.start_time)
        const endTime = new Date(confirmedEvent.end_time)

        const formatTime = (date: Date) => date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
        const formatDate = (date: Date) => date.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })

        const timeStr = `${formatDate(startTime)}, ${formatTime(startTime)} - ${formatTime(endTime)}`

        // Generate and send scheduling email to CP
        const conversation = await getConversationById(action.conversation_id)
        const draft = await generateFinalDraft(
          conversation?.summary_json,
          `Navrhuji schůzku na ${timeStr}${confirmedEvent.location ? `, místo: ${confirmedEvent.location}` : ''}`,
          undefined,
          action.missing_info as { label: string; value: string | null }[] | undefined,
          cp.name || cp.primary_identifier
        )

        await sendEmail(action.user_id, {
          to: cp.primary_identifier,
          subject: draft.subject || `Schůzka - ${timeStr}`,
          body: draft.body,
        })

        await completeAction(actionId)
        return NextResponse.json({
          success: true,
          message: 'Meeting confirmed and invitation sent',
          event: {
            start: confirmedEvent.start_time,
            end: confirmedEvent.end_time,
            location: confirmedEvent.location,
          },
        })
      }

      // Case 3: Simple scheduling without pre-blocks (fallback)
      // User provided a time manually, create the event directly
      const settings = await getUserSettings(action.user_id)
      const userTimeInput = (action.missing_info as { label: string; value: string | null }[] | null)
        ?.[0]?.value

      if (userTimeInput) {
        // Create a calendar event with the CP
        const gcalEvent = await createCalendarEvent(action.user_id, {
          summary: `Meeting with ${cp.name || cp.primary_identifier}`,
          description: action.intent_cs || action.rationale || undefined,
          startTime: new Date(userTimeInput),
          endTime: new Date(new Date(userTimeInput).getTime() + settings.default_meeting_duration * 60 * 1000),
          attendees: [cp.primary_identifier],
          sendUpdates: 'all',
        })

        await completeAction(actionId)
        return NextResponse.json({
          success: true,
          message: 'Meeting created and invitation sent',
        })
      }

      // Default: just mark as completed
      await completeAction(actionId)
      return NextResponse.json({ success: true, message: 'Action completed' })
    }

    // For other action types, just mark as completed
    await completeAction(actionId)
    return NextResponse.json({ success: true, message: 'Action completed' })

  } catch (error) {
    console.error('Error executing action:', error)
    return NextResponse.json(
      { error: 'Failed to execute action' },
      { status: 500 }
    )
  }
}
