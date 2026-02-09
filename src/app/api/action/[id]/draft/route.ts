import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateActionDraft, updateAction } from '@/lib/db/actions'
import { validateActionToken } from '@/lib/auth/tokens'

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
