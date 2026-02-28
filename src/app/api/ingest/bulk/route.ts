import { NextRequest, NextResponse } from 'next/server'
import { runBulkIngestion } from '@/services/bulk-ingestion'
import { verifyApiKey } from '@/lib/auth/api'
import { getUserById } from '@/lib/db/users'
import { purgeUserAsCp } from '@/lib/db/counterparties'
import { publishBulkIngestStep } from '@/lib/qstash/client'
import { createLogCollector } from '@/services/agent'

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

  const effectiveMaxTotal = (maxTotal as number) || 500

  const { logs, capture } = createLogCollector()
  const restore = capture()

  console.log(`\n[BulkIngest] ========== Starting bulk ingestion ==========`)
  console.log(`[BulkIngest] User:  ${userId}`)
  console.log(`[BulkIngest] Since: ${sinceDate.toISOString()}`)
  console.log(`[BulkIngest] Until: ${untilDate ? untilDate.toISOString() : 'now'}`)
  console.log(`[BulkIngest] Max:   ${effectiveMaxTotal} emails`)
  console.log(`[BulkIngest] Time:  ${new Date().toISOString()}`)

  // ── QStash path: split into batched worker steps ──────────────────────────
  // Only use QStash when the app is reachable from the internet (not localhost).
  // QStash is a cloud service that calls back to our endpoint — it can't reach loopback addresses.
  const appBaseUrl = process.env['APP_BASE_URL'] || ''
  const isLocalhost = !appBaseUrl || /localhost|127\.0\.0\.1|\[::1\]/i.test(appBaseUrl)
  if (process.env['QSTASH_TOKEN'] && !isLocalhost) {
    try {
      const user = await getUserById(userId as string)
      if (!user?.email) {
        return NextResponse.json({ error: 'User not found or has no email' }, { status: 404 })
      }

      await purgeUserAsCp(userId as string)

      const job = {
        userId: userId as string,
        since: sinceDate.toISOString(),
        until: untilDate?.toISOString(),
        maxTotal: effectiveMaxTotal,
        userEmail: user.email.toLowerCase(),
        step: 'phase1_inbox' as const,
        totalFetchedInbox: 0,
        totalFetchedSent: 0,
        phase1Stats: {
          inboxFetched: 0,
          sentFetched: 0,
          skippedCategory: 0,
          skippedBlocked: 0,
          skippedFilter: 0,
          skippedDuplicate: 0,
          filterFailOpen: 0,
          stored: 0,
        },
        filteredSenders: [] as { email: string; name: string | null; count: number; reason: string }[],
        errors: [] as string[],
      }

      const messageId = await publishBulkIngestStep(job)
      console.log(`[BulkIngest] Queued via QStash: ${messageId}`)

      restore()
      return NextResponse.json(
        { started: true, mode: 'queued', qstashMessageId: messageId, logs },
        { status: 202 }
      )
    } catch (error) {
      console.error('[BulkIngest] Failed to queue via QStash:', error)
      restore()
      return NextResponse.json(
        { error: 'Failed to queue bulk ingestion', details: error instanceof Error ? error.message : 'Unknown', logs },
        { status: 500 }
      )
    }
  }

  // ── Fallback: run synchronously with NDJSON streaming (local dev) ─────────
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
          effectiveMaxTotal,
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
