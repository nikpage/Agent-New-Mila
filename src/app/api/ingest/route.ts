import { NextRequest, NextResponse } from 'next/server'
import { ingestEmailsForUser } from '@/services/ingestion'
import { processMessagesForThreading } from '@/services/threading'
import { generateActionsForConversations } from '@/services/planning'
import { getUnprocessedMessages } from '@/lib/db/messages'
import { validateCronToken } from '@/lib/auth/tokens'
import { verifyApiKey } from '@/lib/auth/api'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userId, cronToken } = body

    // Either user-specific call or cron job
    if (!userId && !cronToken) {
      return NextResponse.json({ error: 'userId or cronToken required' }, { status: 400 })
    }

    // If cron token provided, validate it (for automated bulk ingestion)
    if (cronToken && !validateCronToken(cronToken)) {
      return NextResponse.json({ error: 'Invalid cron token' }, { status: 401 })
    }

    // If userId provided (manual trigger), verify API key
    if (userId && !cronToken) {
      const authError = verifyApiKey(request)
      if (authError) {
        return authError
      }
    }

    if (userId) {
      const start = Date.now()
      console.log(`\n[Ingest] ========== Starting ingestion ==========`)
      console.log(`[Ingest] User: ${userId}`)
      console.log(`[Ingest] Time: ${new Date().toISOString()}`)

      // Step 1: Ingest emails
      console.log(`[Ingest] Step 1: Fetching new emails from Gmail`)
      const ingested = await ingestEmailsForUser(userId)
      console.log(`[Ingest] Step 1: Ingested ${ingested.length} emails`)

      // Step 2: Process into conversations
      console.log(`[Ingest] Step 2: Threading messages into conversations`)
      const unprocessed = await getUnprocessedMessages(userId)
      const conversations = await processMessagesForThreading(unprocessed)
      console.log(`[Ingest] Step 2: ${unprocessed.length} messages -> ${conversations.size} conversations`)

      // Step 3: Generate actions
      console.log(`[Ingest] Step 3: Generating action proposals`)
      const actions = await generateActionsForConversations(Array.from(conversations.keys()))
      console.log(`[Ingest] Step 3: Generated ${actions.length} actions`)

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`\n[Ingest] ========== Done (${elapsed}s) ==========`)
      console.log(`[Ingest] Emails ingested:  ${ingested.length}`)
      console.log(`[Ingest] Conversations:    ${conversations.size}`)
      console.log(`[Ingest] Actions proposed: ${actions.length}`)
      console.log(`[Ingest] ========================================\n`)

      return NextResponse.json({
        success: true,
        ingested: ingested.length,
        conversations: conversations.size,
        actions: actions.length,
      })
    }

    // Bulk ingestion for all users would go here
    return NextResponse.json({ success: true, message: 'Bulk ingestion not implemented' })
  } catch (error) {
    console.error('[Ingest] FAILED:', error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: 'Ingestion failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
