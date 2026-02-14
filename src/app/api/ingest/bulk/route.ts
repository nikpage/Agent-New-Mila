import { NextRequest, NextResponse } from 'next/server'
import { runBulkIngestion } from '@/services/bulk-ingestion'
import { verifyApiKey } from '@/lib/auth/api'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const authError = verifyApiKey(request)
    if (authError) {
      return authError
    }

    const body = await request.json()
    const { userId, since, until, maxTotal } = body

    if (!userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 })
    }

    if (!since) {
      return NextResponse.json({ error: 'since required (ISO date string)' }, { status: 400 })
    }

    const sinceDate = new Date(since)
    if (isNaN(sinceDate.getTime())) {
      return NextResponse.json({ error: 'Invalid since date' }, { status: 400 })
    }

    const untilDate = until ? new Date(until) : undefined
    if (untilDate && isNaN(untilDate.getTime())) {
      return NextResponse.json({ error: 'Invalid until date' }, { status: 400 })
    }

    console.log(`[BulkIngest] Starting for user ${userId} since ${sinceDate.toISOString()}`)

    const result = await runBulkIngestion(
      userId,
      sinceDate,
      untilDate,
      maxTotal || 500
    )

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error) {
    console.error('[BulkIngest] Error:', error)
    return NextResponse.json(
      { error: 'Bulk ingestion failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
