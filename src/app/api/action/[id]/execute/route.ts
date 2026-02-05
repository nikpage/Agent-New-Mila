import { NextRequest, NextResponse } from 'next/server'
import { getActionById, completeAction, updateActionDraft } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { validateActionToken } from '@/lib/auth/tokens'
import { sendEmail } from '@/lib/google/gmail'
import { generateFinalDraft } from '@/lib/ai/gemini'

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
      // For scheduling, we'll need additional handling
      // For now, just mark as completed
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
