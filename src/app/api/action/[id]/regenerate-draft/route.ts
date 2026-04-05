import { NextRequest, NextResponse } from 'next/server'
import { getActionById, updateActionDraft } from '@/lib/db/actions'
import { getConversationById } from '@/lib/db/conversations'
import { getCPById } from '@/lib/db/counterparties'
import { getUserSettings } from '@/lib/db/users'
import { validateActionToken } from '@/lib/auth/tokens'
import { regenerateDraftWithInstruction } from '@/lib/ai/mila-voice'

/**
 * POST /api/action/[id]/regenerate-draft
 * Regenerates the draft with a user instruction via draft_edit stage (Haiku → Sonnet).
 * Returns the new draft for inline display.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: actionId } = await params
    const body = await request.json()
    const { token, instruction } = body

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 401 })
    }

    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      return NextResponse.json({ error: 'Missing instruction' }, { status: 400 })
    }

    const action = await getActionById(actionId)
    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 })
    }

    if (!validateActionToken(token, actionId, action.user_id)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const [cp, conversation, settings] = await Promise.all([
      getCPById(action.cp_id),
      getConversationById(action.conversation_id),
      getUserSettings(action.user_id),
    ])

    const payload = action.payload as Record<string, unknown> | null
    const channel = (payload?.channel as 'email' | 'whatsapp') || 'email'

    const currentDraft = {
      subject: action.draft_subject || '',
      body: action.draft_body_text || action.intent_cs || action.rationale || '',
    }

    const missingInfo = (action.missing_info as { label: string; placeholder?: string; value: string | null }[] | null) || undefined

    const newDraft = await regenerateDraftWithInstruction(
      currentDraft,
      instruction.trim(),
      conversation?.summary_json,
      cp?.name || cp?.primary_identifier || 'Counterparty',
      channel,
      settings,
      missingInfo
    )

    // Save the regenerated draft
    await updateActionDraft(actionId, newDraft.subject, newDraft.body)

    return NextResponse.json({
      subject: newDraft.subject,
      body: newDraft.body,
    })
  } catch (error) {
    console.error('[RegenerateDraft]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to regenerate draft' },
      { status: 500 }
    )
  }
}
