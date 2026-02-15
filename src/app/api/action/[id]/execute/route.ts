import { NextRequest, NextResponse } from 'next/server'
import { getActionById, completeAction, updateActionDraft } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { validateActionToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/lib/google/gmail'
import { generateFinalDraft } from '@/lib/ai/gemini'
import { acceptInvitation, declineInvitation, confirmSlot } from '@/services/scheduling'
import { createCalendarEvent, confirmCalendarEvent, deleteCalendarEvent } from '@/lib/google/calendar'
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

    // Get user settings for AI context
    const settings = await getUserSettings(action.user_id)

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
          settings,
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
        subject: draftSubject || 'Re:',
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

      // Case 2: Pre-blocked slots - user approved
      const preBlockGroupId = payload?.pre_block_group_id as string | undefined
      const blockedSlots = payload?.blocked_slots as { id: string; gcal_event_id?: string; start: string; end: string; location?: string }[] | undefined

      if (preBlockGroupId && blockedSlots && blockedSlots.length > 0) {
        const formatTime = (date: Date) => date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
        const formatDate = (date: Date) => date.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })

        // Filter slots based on user's slot selection (from UPRAVIT page)
        const slotSelection = (payload?.slotSelection as string) || ''
        let slotsToSend = blockedSlots
        let selectedNumbers: number[] = []

        if (slotSelection && slotSelection.toLowerCase() !== 'vše' && slotSelection.toLowerCase() !== 'all') {
          // Parse selected slot numbers (e.g., "1", "1,3", "2")
          selectedNumbers = slotSelection
            .split(/[,\s]+/)
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n) && n >= 1 && n <= blockedSlots.length)

          if (selectedNumbers.length > 0) {
            slotsToSend = selectedNumbers.map(n => blockedSlots[n - 1])
          }
        }

        const userNotes = (payload?.userNotes as string) || ''

        // NEW LOGIC: Single slot selected -> Confirm & Invite
        if (selectedNumbers.length === 1) {
          const index = selectedNumbers[0] - 1
          const selectedSlot = blockedSlots[index]
          const unselectedSlots = blockedSlots.filter((_, i) => i !== index)
          const loc = payload?.location as string | undefined

          // Determine Title: Location OR "HOVOR - CP Name"
          let finalTitle = `HOVOR - ${cp.name || cp.primary_identifier}`
          if (loc && loc.trim().length > 0) {
             finalTitle = loc
          }

          // 1. Confirm GCal Event (sends invite)
          if (selectedSlot.gcal_event_id) {
            await confirmCalendarEvent(
              action.user_id,
              selectedSlot.gcal_event_id,
              [cp.primary_identifier],
              {
                summary: finalTitle,
                location: loc,
                description: `Schůzka s ${cp.name || cp.primary_identifier}`
              }
            )
          }

          // 2. Delete Unselected GCal Events
          for (const slot of unselectedSlots) {
            if (slot.gcal_event_id) {
              await deleteCalendarEvent(action.user_id, slot.gcal_event_id)
            }
          }

          // 3. Confirm Local Event (updates DB, cleans up local siblings)
          // Pass undefined for cpEmail to prevent confirmSlot from creating a DUPLICATE GCal event
          await confirmSlot(
            action.user_id,
            selectedSlot.id,
            preBlockGroupId,
            undefined, // cpEmail
            loc,
            finalTitle // New title for local DB
          )

          // 4. Send the drafted email (Context/Cover letter)
          // We still send this because the draft might contain specific answers or context
          const conversation = await getConversationById(action.conversation_id)
          const draft = await generateFinalDraft(
            conversation?.summary_json,
            `Potvrzuji termín schůzky: ${formatDate(new Date(selectedSlot.start))}, ${formatTime(new Date(selectedSlot.start))} - ${formatTime(new Date(selectedSlot.end))}. Pozvánka v kalendáři byla odeslána.${userNotes ? `\n\nPoznámka: ${userNotes}` : ''}`,
            settings,
            userNotes || undefined,
            undefined,
            cp.name || cp.primary_identifier
          )

          await sendEmail(action.user_id, {
            to: cp.primary_identifier,
            subject: draft.subject || `Potvrzení schůzky`,
            body: draft.body,
          })

          await completeAction(actionId)
          return NextResponse.json({
            success: true,
            message: 'Meeting confirmed and invitation sent',
          })
        }

        // Default Logic: Multiple slots or "all" -> Send Options via Email
        const formattedSlots = slotsToSend.map((s, i) => {
          const start = new Date(s.start)
          const end = new Date(s.end)
          return `${i + 1}. ${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}`
        })

        const locationStr = (payload?.location as string) || ''
        const slotsText = formattedSlots.join('\n')

        // Generate email to CP with selected time options - CP picks one
        const conversation = await getConversationById(action.conversation_id)
        const draft = await generateFinalDraft(
          conversation?.summary_json,
          `Navrhuji schůzku. Nabízím tyto termíny:\n${slotsText}${locationStr ? `\nMísto: ${locationStr}` : ''}\nProsím dejte vědět, který termín vám vyhovuje.${userNotes ? `\n\nPoznámka: ${userNotes}` : ''}`,
          settings,
          userNotes || undefined,
          undefined,
          cp.name || cp.primary_identifier
        )

        // Send email to CP with options - NO calendar invite to CP, NO slot confirmation yet
        await sendEmail(action.user_id, {
          to: cp.primary_identifier,
          subject: draft.subject || `Návrh schůzky`,
          body: draft.body,
        })

        await completeAction(actionId)
        return NextResponse.json({
          success: true,
          message: 'Meeting options sent to CP via email',
          slots: formattedSlots,
        })
      }

      // Case 3: Simple scheduling without pre-blocks (fallback)
      // User provided a time manually, create the event directly
      const userTimeInput = (action.missing_info as { label: string; value: string | null }[] | null)
        ?.[0]?.value

      if (userTimeInput) {
        // Create a calendar event with the CP
        const gcalEvent = await createCalendarEvent(action.user_id, {
          summary: `Schůzka s ${cp.name || cp.primary_identifier}`,
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
