import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateActionDraft, updateAction, dismissAction, dismissAllPendingActions } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getUserSettings } from '@/lib/db/users'
import { validateActionToken } from '@/lib/auth/tokens'
import { generateFinalDraft } from '@/lib/ai/gemini'

/**
 * POST — Generate a draft for an action without executing it.
 * Returns { subject, body, to } for the user to review/edit before sending.
 */
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

    const action = await getActionById(actionId)
    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const cp = await getCPById(action.cp_id)
    if (!cp) {
      return NextResponse.json({ error: 'Counterparty not found' }, { status: 404 })
    }

    const sendTo = ((action.payload as Record<string, unknown>)?.editedTo as string) || cp.primary_identifier

    // If draft already exists, return it
    if (action.draft_body_text) {
      return NextResponse.json({
        subject: action.draft_subject || '',
        body: action.draft_body_text,
        to: sendTo,
      })
    }

    // Generate a new draft
    const conversation = await getConversationById(action.conversation_id)
    const settings = await getUserSettings(action.user_id)
    const payload = action.payload as Record<string, unknown> | null
    const userNotes = (payload?.userNotes as string) || undefined
    const missingInfo = (action.missing_info as { label: string; placeholder: string; value: string | null }[] | null) || undefined

    let draftIntent = action.intent_cs || action.rationale_cs || action.rationale

    // For SCHEDULE actions with selected slots, build slot-specific intent
    if (action.action_type === 'SCHEDULE' && payload) {
      const blockedSlots = payload.blocked_slots as { id: string; start: string; end: string; location?: string }[] | undefined
      const slotSelection = (payload.slotSelection as string) || ''

      if (blockedSlots && blockedSlots.length > 0 && slotSelection) {
        const formatTime = (d: Date) => d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
        const formatDate = (d: Date) => d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })

        let slotsToSend = blockedSlots
        const selectedNumbers = slotSelection.split(/[,\s]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 1 && n <= blockedSlots.length)

        if (selectedNumbers.length > 0) {
          slotsToSend = selectedNumbers.map(n => blockedSlots[n - 1])
        }

        if (selectedNumbers.length === 1) {
          const slot = slotsToSend[0]
          const start = new Date(slot.start)
          const end = new Date(slot.end)
          draftIntent = `Potvrzuji termín schůzky: ${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}. Pozvánka v kalendáři byla odeslána.${userNotes ? `\n\nPoznámka: ${userNotes}` : ''}`
        } else {
          const formattedSlots = slotsToSend.map((s, i) => {
            const start = new Date(s.start)
            const end = new Date(s.end)
            return `${i + 1}. ${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}`
          })
          const locationStr = (payload.location as string) || ''
          draftIntent = `Navrhuji schůzku. Nabízím tyto termíny:\n${formattedSlots.join('\n')}${locationStr ? `\nMísto: ${locationStr}` : ''}\nProsím dejte vědět, který termín vám vyhovuje.${userNotes ? `\n\nPoznámka: ${userNotes}` : ''}`
        }
      }
    }

    const draft = await generateFinalDraft(
      conversation?.summary_json,
      draftIntent,
      settings,
      userNotes,
      missingInfo,
      cp.name || cp.primary_identifier
    )

    // Save the generated draft
    await updateActionDraft(actionId, draft.subject, draft.body)

    return NextResponse.json({
      subject: draft.subject,
      body: draft.body,
      to: sendTo,
    })

  } catch (error) {
    console.error('Error generating draft:', error)
    return NextResponse.json(
      { error: 'Failed to generate draft' },
      { status: 500 }
    )
  }
}

/** Commands the user can type to dismiss this action or all pending actions */
const CANCEL_ALL_COMMANDS = ['cancel all', 'zrušit vše', 'zrušit všechno', 'zruš vše', 'zruš všechno']
const CANCEL_THIS_COMMANDS = ['cancel', 'zrušit', 'zruš', 'ne', 'nechci']

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token, subject, body: draftBody, to, notes, dynamicFields } = body

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

    // Check for verbal cancel commands in notes
    const notesLower = (notes || '').trim().toLowerCase()
    if (notesLower && CANCEL_ALL_COMMANDS.includes(notesLower)) {
      const dismissed = await dismissAllPendingActions(action.user_id)
      return NextResponse.json({ success: true, command: 'cancel_all', dismissed })
    }
    if (notesLower && CANCEL_THIS_COMMANDS.includes(notesLower)) {
      await dismissAction(actionId)
      return NextResponse.json({ success: true, command: 'cancel_this' })
    }

    // Update the draft if subject/body provided
    if (subject || draftBody) {
      await updateActionDraft(actionId, subject || '', draftBody || '')
    }

    // Update missing_info with dynamic field values
    if (dynamicFields) {
      const missingInfo = (action.missing_info as { label: string; placeholder: string; value: string | null }[] | null) || []
      const updatedMissingInfo = missingInfo.map(field => ({
        ...field,
        value: dynamicFields[field.label] || field.value
      }))

      await updateAction(actionId, {
        missing_info: updatedMissingInfo
      })
    }

    // Persist edited recipient if provided
    if (to) {
      const currentPayload = (action.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...currentPayload, editedTo: to },
      })
    }

    // Store notes in payload if provided
    if (notes) {
      const currentPayload = (action.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...currentPayload, userNotes: notes },
      })
    }

    // Handle slot selection for SCHEDULE actions — update intent_cs to reflect selection
    if (dynamicFields?.slotSelection) {
      const currentPayload = (action.payload as Record<string, unknown>) || {}
      const blockedSlots = currentPayload?.blocked_slots as { id: string; start: string; end: string; location?: string }[] | undefined

      let updatedIntentCs = action.intent_cs
      if (blockedSlots && blockedSlots.length > 0) {
        const selection = dynamicFields.slotSelection
        const formatTime = (d: Date) => d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
        const formatDate = (d: Date) => d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })

        if (selection.toLowerCase() === 'vše' || selection.toLowerCase() === 'all') {
          // All slots selected
          const formatted = blockedSlots.map((s, i) => {
            const start = new Date(s.start)
            const end = new Date(s.end)
            return `${i + 1}. ${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}`
          })
          updatedIntentCs = `Vybrány všechny termíny k odeslání:\n${formatted.join('\n')}${currentPayload?.location ? `\nMísto: ${currentPayload.location}` : ''}`
        } else {
          // Parse selected numbers
          const selectedNumbers = selection.split(/[,\s]+/).map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n) && n >= 1 && n <= blockedSlots.length)
          if (selectedNumbers.length > 0) {
            const formatted = selectedNumbers.map((n: number) => {
              const s = blockedSlots[n - 1]
              const start = new Date(s.start)
              const end = new Date(s.end)
              return `${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}`
            })
            updatedIntentCs = `Vybrané termíny k odeslání:\n${formatted.map((f: string, i: number) => `${i + 1}. ${f}`).join('\n')}${currentPayload?.location ? `\nMísto: ${currentPayload.location}` : ''}`
          } else {
            // Custom instruction (e.g. "přeplánuj na středu v 16")
            updatedIntentCs = `Vlastní pokyn: ${selection}${currentPayload?.location ? `\nMísto: ${currentPayload.location}` : ''}`
          }
        }
      }

      await updateAction(actionId, {
        intent_cs: updatedIntentCs,
        payload: { ...currentPayload, slotSelection: dynamicFields.slotSelection },
      })
    }

    // If notes provided, also update intent_cs to append the notes
    if (notes && !dynamicFields?.slotSelection) {
      const currentIntentCs = action.intent_cs || action.rationale_cs || action.rationale
      await updateAction(actionId, {
        intent_cs: `${currentIntentCs}\n\nPoznámka: ${notes}`,
      })
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Error updating draft:', error)
    return NextResponse.json(
      { error: 'Failed to update draft' },
      { status: 500 }
    )
  }
}
