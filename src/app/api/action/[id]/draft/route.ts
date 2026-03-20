import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateActionDraft, updateAction, dismissAction, dismissAllPendingActions } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getUserSettings } from '@/lib/db/users'
import { validateActionToken } from '@/lib/auth/tokens'
import { generateFinalDraft } from '@/lib/ai/mila-voice'
import { geocodeAddress } from '@/lib/google/maps'

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

    // Fetch CP, conversation, settings all in parallel
    const [cp, conversation, settings] = await Promise.all([
      getCPById(action.cp_id),
      getConversationById(action.conversation_id),
      getUserSettings(action.user_id),
    ])
    if (!cp) {
      return NextResponse.json({ error: 'Counterparty not found' }, { status: 404 })
    }

    const sendTo = ((action.payload as Record<string, unknown>)?.editedTo as string) || cp.primary_identifier

    // Action metadata for the client (avoids needing a separate GET call)
    const actionMeta = {
      action,
      conversation,
      cp,
    }

    // If draft already exists, return it with action metadata
    if (action.draft_body_text) {
      return NextResponse.json({
        subject: action.draft_subject || '',
        body: action.draft_body_text,
        to: sendTo,
        ...actionMeta,
      })
    }

    const payload = action.payload as Record<string, unknown> | null
    const userNotes = (payload?.userNotes as string) || undefined
    const missingInfo = (action.missing_info as { label: string; placeholder: string; value: string | null }[] | null) || undefined

    let draftIntent = action.intent_cs || action.rationale_cs || action.rationale

    // For SCHEDULE actions with a hold event, build slot-specific intent
    if (action.action_type === 'SCHEDULE' && payload) {
      const holdStart = payload.start as string | undefined
      const holdEnd = payload.end as string | undefined

      if (holdStart && holdEnd) {
        const tz = settings.timezone || 'Europe/Prague'
        const formatTime = (d: Date) => d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
        const formatDate = (d: Date) => d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })

        const start = new Date(holdStart)
        const end = new Date(holdEnd)
        draftIntent = `Potvrzuji termín schůzky: ${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}. Pozvánka v kalendáři byla odeslána.${userNotes ? `\n\nPoznámka: ${userNotes}` : ''}`
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
      ...actionMeta,
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
    const { token, subject, body: draftBody, to, notes, dynamicFields, isOnline, meetingType } = body

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

    const settings = await getUserSettings(action.user_id)

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

      // Batch all payload updates into one write to avoid race conditions
      const locationField = missingInfo.find(f => f.label.includes('adresa'))
      const locationValue = locationField ? dynamicFields[locationField.label] : undefined
      const payloadUpdates: Record<string, unknown> = {}

      if (locationValue) {
        let resolvedLocation = locationValue
        let locationPartial = true
        try {
          const geocoded = await geocodeAddress(locationValue)
          if (geocoded) {
            resolvedLocation = geocoded.formattedAddress
            locationPartial = false
          }
        } catch {
          // Geocoding failed — keep raw value, mark as partial
        }
        payloadUpdates.location = resolvedLocation
        payloadUpdates.location_partial = locationPartial
      }

      if (typeof isOnline === 'boolean' && action.action_type === 'SCHEDULE') {
        payloadUpdates.is_online = isOnline
      }

      if (meetingType && action.action_type === 'SCHEDULE') {
        payloadUpdates.meeting_type = meetingType
      }

      if (to) {
        payloadUpdates.editedTo = to
      }

      if (Object.keys(payloadUpdates).length > 0) {
        const freshAction = await getActionById(actionId)
        const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
        await updateAction(actionId, {
          payload: { ...freshPayload, ...payloadUpdates } as Record<string, unknown> & { [key: string]: string | number | boolean | null },
        })
      }
    } else {
      // No dynamicFields — still handle is_online and to
      const payloadUpdates: Record<string, unknown> = {}

      if (typeof isOnline === 'boolean' && action.action_type === 'SCHEDULE') {
        payloadUpdates.is_online = isOnline
      }

      if (meetingType && action.action_type === 'SCHEDULE') {
        payloadUpdates.meeting_type = meetingType
      }

      if (to) {
        payloadUpdates.editedTo = to
      }

      if (Object.keys(payloadUpdates).length > 0) {
        const freshAction = await getActionById(actionId)
        const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
        await updateAction(actionId, {
          payload: { ...freshPayload, ...payloadUpdates } as Record<string, unknown> & { [key: string]: string | number | boolean | null },
        })
      }
    }

    // Store notes in payload if provided
    if (notes) {
      const freshAction = await getActionById(actionId)
      const freshPayload = (freshAction?.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...freshPayload, userNotes: notes },
      })
    }

    // Handle user edits for SCHEDULE actions — update intent_cs with hold info
    if (dynamicFields?.slotSelection) {
      const currentPayload = (action.payload as Record<string, unknown>) || {}
      const holdStart = currentPayload?.start as string | undefined
      const holdEnd = currentPayload?.end as string | undefined

      let updatedIntentCs = action.intent_cs
      if (holdStart && holdEnd) {
        const selection = dynamicFields.slotSelection
        const tz = settings.timezone || 'Europe/Prague'
        const formatTime = (d: Date) => d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
        const formatDate = (d: Date) => d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })

        const start = new Date(holdStart)
        const end = new Date(holdEnd)

        // Custom instruction from user (e.g. "přeplánuj na středu v 16")
        updatedIntentCs = `Vlastní pokyn: ${selection}\nPůvodní termín: ${formatDate(start)}, ${formatTime(start)} - ${formatTime(end)}${currentPayload?.location ? `\nMísto: ${currentPayload.location}` : ''}`
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
