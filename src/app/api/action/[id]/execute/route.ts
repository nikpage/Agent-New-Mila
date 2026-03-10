import { NextRequest, NextResponse } from 'next/server'
import { getActionById, completeAction, updateActionDraft } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { validateActionToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/lib/google/gmail'
import { sendWhatsAppMessage } from '@/lib/whatsapp/sender'
import { generateFinalDraft } from '@/lib/ai/gemini'
import { acceptInvitation, declineInvitation, confirmSlot } from '@/services/scheduling'
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

    // Idempotency: prevent double-execution (e.g. user double-clicks, network retry)
    if (action.status !== 'pending' && action.status !== 'approved') {
      return NextResponse.json(
        { error: 'Action already executed', status: action.status },
        { status: 409 }
      )
    }

    // Fetch settings + CP in parallel (both only need IDs from action)
    const [settings, cp] = await Promise.all([
      getUserSettings(action.user_id),
      getCPById(action.cp_id),
    ])

    if (!cp) {
      return NextResponse.json({ error: 'Counterparty not found' }, { status: 404 })
    }

    // Check action type and required data
    if (action.action_type === 'REPLY') {

      const actionPayload = (action.payload as Record<string, unknown>) || {}
      const channel = (actionPayload.channel as 'email' | 'whatsapp') || 'email'

      // Generate draft if it doesn't exist
      let draftSubject = action.draft_subject
      let draftBody = action.draft_body_text

      if (!draftBody) {
        const conversation = await getConversationById(action.conversation_id)
        if (!conversation) {
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
        }

        const userNotes = (actionPayload.userNotes as string) || undefined
        const missingInfo = (action.missing_info as { label: string; placeholder: string; value: string | null }[] | null) || undefined

        const draft = await generateFinalDraft(
          conversation.summary_json,
          action.intent_cs || action.rationale_cs || action.rationale,
          settings,
          userNotes,
          missingInfo,
          cp.name || cp.primary_identifier,
          channel
        )

        draftSubject = draft.subject
        draftBody = draft.body

        // Save the generated draft
        await updateActionDraft(actionId, draftSubject, draftBody)
      }

      if (!draftBody) {
        return NextResponse.json({ error: 'Draft body is empty — cannot send' }, { status: 400 })
      }

      // Use edited recipient if saved, otherwise fall back to CP
      const sendTo = (actionPayload.editedTo as string) || cp.primary_identifier

      if (channel === 'whatsapp') {
        // Send via WhatsApp daemon
        const waResult = await sendWhatsAppMessage(action.user_id, sendTo, draftBody, settings)
        if (!waResult.success) {
          return NextResponse.json(
            { error: `WhatsApp send failed: ${waResult.error}` },
            { status: 502 }
          )
        }
      } else {
        // Validate email address before attempting Gmail send
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!sendTo || !emailRegex.test(sendTo)) {
          return NextResponse.json(
            { error: `Invalid recipient email: "${sendTo}". Check the counterparty's email address.` },
            { status: 400 }
          )
        }

        // Send via Gmail
        await sendEmail(action.user_id, {
          to: sendTo,
          subject: draftSubject || 'Re:',
          body: draftBody,
        })
      }

      // Mark action as completed
      await completeAction(actionId)

      return NextResponse.json({ success: true, message: channel === 'whatsapp' ? 'WhatsApp message sent' : 'Email sent' })
    }

    if (action.action_type === 'SCHEDULE') {
      const payload = action.payload as Record<string, unknown>

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

      // Case 2: Single hold event — user approved the optimal slot
      const holdEventId = payload?.hold_event_id as string | undefined
      const gcalEventId = payload?.gcal_event_id as string | undefined

      if (holdEventId) {
        const holdStart = payload?.start as string | undefined
        const holdEnd = payload?.end as string | undefined
        const isOnline = !!payload?.is_online
        const loc = isOnline ? undefined : (payload?.location as string | undefined)
        const userNotes = (payload?.userNotes as string) || ''

        const tz = settings.timezone || 'Europe/Prague'
        const formatTime = (date: Date) => date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
        const formatDate = (date: Date) => date.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })

        // Determine Title: Location OR "HOVOR - CP Name" for online
        let finalTitle = `HOVOR - ${cp.name || cp.primary_identifier}`
        if (!isOnline && loc && loc.trim().length > 0) {
          finalTitle = loc
        }

        const conversation = await getConversationById(action.conversation_id)
        const startDate = holdStart ? new Date(holdStart) : new Date()
        const endDate = holdEnd ? new Date(holdEnd) : new Date()

        // Generate agenda text — goes into calendar invite description (not a separate email)
        const draft = await generateFinalDraft(
          conversation?.summary_json,
          `Potvrzuji termín schůzky: ${formatDate(startDate)}, ${formatTime(startDate)} - ${formatTime(endDate)}.${userNotes ? `\n\nPoznámka: ${userNotes}` : ''}`,
          settings,
          userNotes || undefined,
          undefined,
          cp.name || cp.primary_identifier
        )
        const agendaText = draft.body

        // Confirm hold event in DB + GCal (adds CP as attendee, Google sends invite)
        await confirmSlot(
          action.user_id,
          holdEventId,
          cp.primary_identifier,
          loc,
          finalTitle,
          agendaText,
          isOnline
        )

        await completeAction(actionId)
        return NextResponse.json({
          success: true,
          message: 'Meeting confirmed and invitation sent',
        })
      }

      // Case 3: Simple scheduling without pre-blocks (fallback)
      // User provided a time manually, create the event directly
      const userTimeInput = (action.missing_info as { label: string; value: string | null }[] | null)
        ?.[0]?.value

      if (userTimeInput) {
        const manualStart = new Date(userTimeInput)
        const manualEnd = new Date(manualStart.getTime() + settings.default_meeting_duration * 60 * 1000)
        const manualTitle = `Schůzka s ${cp.name || cp.primary_identifier}`
        const manualDescription = action.intent_cs || action.rationale || ''

        // Create calendar event with CP as attendee — Google Calendar sends the invite natively
        await createCalendarEvent(action.user_id, {
          summary: manualTitle,
          description: manualDescription,
          startTime: manualStart,
          endTime: manualEnd,
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

    // TODO: user handles it themselves, just mark as completed
    if (action.action_type === 'TODO') {
      await completeAction(actionId)
      return NextResponse.json({ success: true, message: 'Todo marked as done' })
    }

    // WAIT and ARCHIVE are internal states — not executable
    if (action.action_type === 'WAIT' || action.action_type === 'ARCHIVE') {
      return NextResponse.json(
        { error: `Action type ${action.action_type} is not executable` },
        { status: 400 }
      )
    }

    // For any other action types, just mark as completed
    await completeAction(actionId)
    return NextResponse.json({ success: true, message: 'Action completed' })

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error executing action:', message, error)
    return NextResponse.json(
      { error: `Failed to execute action: ${message}` },
      { status: 500 }
    )
  }
}
