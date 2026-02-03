import { NextRequest, NextResponse } from 'next/server'
import { ingestEmailsForUser } from '@/services/ingestion'
import { processMessagesForThreading } from '@/services/threading'
import { generateActionsForConversations } from '@/services/planning'
import { getUnprocessedMessages } from '@/lib/db/messages'
import { validateCronToken } from '@/lib/auth/tokens'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userId, cronToken } = body

    // Either user-specific call or cron job
    if (!userId && !cronToken) {
      return NextResponse.json({ error: 'userId or cronToken required' }, { status: 400 })
    }

    // If cron token provided, validate it
    if (cronToken && !validateCronToken(cronToken)) {
      return NextResponse.json({ error: 'Invalid cron token' }, { status: 401 })
    }

    if (userId) {
      // Single user ingestion
      console.log(`[Ingest] Processing user: ${userId}`)

      // Step 1: Ingest emails
      const ingested = await ingestEmailsForUser(userId)
      console.log(`[Ingest] Ingested ${ingested.length} emails`)

      // Step 2: Process into conversations
      const unprocessed = await getUnprocessedMessages(userId)
      const conversations = await processMessagesForThreading(unprocessed)
      console.log(`[Ingest] Processed ${conversations.size} conversations`)

      // Step 3: Generate actions
      const actions = await generateActionsForConversations(Array.from(conversations.keys()))
      console.log(`[Ingest] Generated ${actions.length} actions`)

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
    console.error('[Ingest] Error:', error)
    return NextResponse.json(
      { error: 'Ingestion failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
