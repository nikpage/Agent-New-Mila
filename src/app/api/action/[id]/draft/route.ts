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

    // Handle slot selection for SCHEDULE actions
    if (dynamicFields?.slotSelection) {
      const currentPayload = (action.payload as Record<string, unknown>) || {}
      await updateAction(actionId, {
        payload: { ...currentPayload, slotSelection: dynamicFields.slotSelection },
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
