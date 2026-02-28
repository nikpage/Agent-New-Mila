import { NextRequest, NextResponse } from 'next/server'
import { runAgentForUser } from '@/services/agent'
import { verifyApiKey } from '@/lib/auth/api'

export const maxDuration = 300 // 5 minutes for longer processing

export async function POST(request: NextRequest) {
  // Verify API key
  const authError = verifyApiKey(request)
  if (authError) {
    return authError
  }

  try {
    const body = await request.json()
    const { userId } = body

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }

    const start = Date.now()
    console.log(`\n[Agent] ========== Starting agent run ==========`)
    console.log(`[Agent] User: ${userId}`)
    console.log(`[Agent] Time: ${new Date().toISOString()}`)

    const result = await runAgentForUser(userId)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)

    console.log(`\n[Agent] ========== Run complete (${elapsed}s) ==========`)
    console.log(`[Agent] Success: ${result.success}`)
    console.log(`[Agent] Emails ingested:    ${result.emailsIngested}`)
    console.log(`[Agent] WhatsApp messages:  ${result.whatsappMessagesProcessed}`)
    console.log(`[Agent] Calendar synced:    ${result.calendarEventsSynced}`)
    console.log(`[Agent] Calendar invites:   ${result.calendarInvitationsDetected}`)
    console.log(`[Agent] Messages processed: ${result.messagesProcessed}`)
    console.log(`[Agent] Conversations:      ${result.conversationsUpdated}`)
    console.log(`[Agent] Actions generated:  ${result.actionsGenerated}`)
    console.log(`[Agent] Follow-ups:         ${result.followUpsGenerated}`)
    console.log(`[Agent] Cooling leads:      ${result.coolingLeads}`)
    console.log(`[Agent] Cold leads:         ${result.coldLeads}`)
    if (result.errors.length > 0) {
      console.log(`[Agent] Errors (${result.errors.length}):`)
      result.errors.forEach((e, i) => console.log(`[Agent]   ${i + 1}. ${e}`))
    }
    console.log(`[Agent] ============================================\n`)

    // result.logs already contains all logs captured during runAgentForUser
    return NextResponse.json(result)
  } catch (error) {
    console.error('[Agent] Run FAILED:', error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: 'Agent run failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
