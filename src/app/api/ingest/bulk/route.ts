import { NextRequest, NextResponse } from 'next/server'
import { runBulkIngestion } from '@/services/bulk-ingestion'
import { verifyApiKey } from '@/lib/auth/api'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  // Validate request before starting stream
  const authError = verifyApiKey(request)
  if (authError) {
    return authError
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { userId, since, until, maxTotal } = body

  if (!userId) {
    return NextResponse.json({ error: 'userId required' }, { status: 400 })
  }

  if (!since) {
    return NextResponse.json({ error: 'since required (ISO date string)' }, { status: 400 })
  }

  const sinceDate = new Date(since as string)
  if (isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: 'Invalid since date' }, { status: 400 })
  }

  const untilDate = until ? new Date(until as string) : undefined
  if (untilDate && isNaN(untilDate.getTime())) {
    return NextResponse.json({ error: 'Invalid until date' }, { status: 400 })
  }

  console.log(`[BulkIngest] Starting for user ${userId} since ${sinceDate.toISOString()}`)

  // Stream NDJSON so the client sees progress and the connection stays alive
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'))
        } catch {
          // Stream may already be closed
        }
      }

      try {
        send({ event: 'started', userId, since: sinceDate.toISOString() })

        const result = await runBulkIngestion(
          userId as string,
          sinceDate,
          untilDate,
          (maxTotal as number) || 500,
          (progress) => send({ event: 'progress', ...progress })
        )

        send({ event: 'done', success: true, ...result })
      } catch (error) {
        console.error('[BulkIngest] Error:', error)
        send({
          event: 'error',
          error: 'Bulk ingestion failed',
          details: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
