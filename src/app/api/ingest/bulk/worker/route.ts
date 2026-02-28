import { NextRequest, NextResponse } from 'next/server'
import { validateCronToken } from '@/lib/auth/tokens'
import { publishBulkIngestStep } from '@/lib/qstash/client'
import { fetchEmailsBatch } from '@/lib/google/gmail'
import {
  processEmailBatch,
  phase2Enrich,
  phase3Thread,
  phase4Classify,
  type BulkIngestionPhase1Result,
  type FilteredSender,
} from '@/services/bulk-ingestion'
import { generateAndSendBackfillReport } from '@/services/backfill-report'
import { getUserSettings } from '@/lib/db/users'
import { getKeyUsageSummary } from '@/lib/ai/providers/gemini'

export const maxDuration = 300

const BATCH_SIZE = 50

interface BulkIngestJob {
  userId: string
  since: string
  until?: string
  maxTotal: number
  userEmail: string
  step: 'phase1_inbox' | 'phase1_sent' | 'phase2_enrich' | 'phase3_thread' | 'phase4_classify' | 'phase5_report'
  pageToken?: string
  totalFetchedInbox: number
  totalFetchedSent: number
  phase1Stats: BulkIngestionPhase1Result
  filteredSenders: FilteredSender[]
  errors: string[]
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')

  if (!validateCronToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const job: BulkIngestJob = await request.json()
  const { userId, step } = job

  console.log(`[BulkIngest/Worker] Step: ${step} for user ${userId}`)

  try {
    switch (step) {
      case 'phase1_inbox':
      case 'phase1_sent': {

        const query = step === 'phase1_inbox'
          ? '-in:spam -in:trash -in:sent -in:draft'
          : 'in:sent'

        const totalFetchedKey = step === 'phase1_inbox' ? 'totalFetchedInbox' : 'totalFetchedSent'
        const statsKey = step === 'phase1_inbox' ? 'inboxFetched' : 'sentFetched'
        const remaining = job.maxTotal - job[totalFetchedKey]

        if (remaining <= 0) {
          const nextStep = step === 'phase1_inbox' ? 'phase1_sent' : 'phase2_enrich'
          await publishBulkIngestStep({ ...job, step: nextStep, pageToken: undefined })
          return NextResponse.json({ ok: true, next: nextStep })
        }

        const batchResult = await fetchEmailsBatch(userId, {
          query,
          after: new Date(job.since),
          before: job.until ? new Date(job.until) : undefined,
          maxResults: Math.min(BATCH_SIZE, remaining),
          pageToken: job.pageToken,
        })

        const batchEmails = batchResult.messages
        job.phase1Stats[statsKey] += batchEmails.length
        job[totalFetchedKey] += batchEmails.length

        await processEmailBatch(
          userId,
          job.userEmail,
          batchEmails,
          job.phase1Stats,
          job.filteredSenders,
          job.errors,
        )

        console.log(`[BulkIngest/Worker] ${step}: batch=${batchEmails.length}, stored=${job.phase1Stats.stored}, skipped=${job.phase1Stats.skippedCategory + job.phase1Stats.skippedBlocked + job.phase1Stats.skippedFilter + job.phase1Stats.skippedDuplicate}, totalFetched=${job[totalFetchedKey]}, keys=[${getKeyUsageSummary()}]`)

        const newRemaining = job.maxTotal - job[totalFetchedKey]
        if (batchResult.nextPageToken && newRemaining > 0) {
          console.log(`[BulkIngest/Worker] ${step}: chaining next page, ${newRemaining} remaining`)
          await publishBulkIngestStep({ ...job, pageToken: batchResult.nextPageToken })
          return NextResponse.json({ ok: true, next: step, remaining: newRemaining })
        } else {
          const nextStep = step === 'phase1_inbox' ? 'phase1_sent' : 'phase2_enrich'
          console.log(`[BulkIngest/Worker] ${step}: done, moving to ${nextStep}`)
          await publishBulkIngestStep({ ...job, step: nextStep, pageToken: undefined })
          return NextResponse.json({ ok: true, next: nextStep })
        }
      }

      case 'phase2_enrich': {
        const settings = await getUserSettings(userId)
        const logProgress = (p: Record<string, unknown>) =>
          console.log('[BulkIngest/Worker] Phase 2:', JSON.stringify(p))
        const p2 = await phase2Enrich(userId, logProgress, settings)
        console.log(`[BulkIngest/Worker] Phase 2 complete: ${p2.enriched} enriched, ${p2.enrichmentFailed} failed, ${p2.embedded} embedded, keys=[${getKeyUsageSummary()}]`)

        await publishBulkIngestStep({ ...job, step: 'phase3_thread' })
        return NextResponse.json({ ok: true, next: 'phase3_thread', enriched: p2.enriched })
      }

      case 'phase3_thread': {
        const logProgress = (p: Record<string, unknown>) =>
          console.log('[BulkIngest/Worker] Phase 3:', JSON.stringify(p))
        const p3 = await phase3Thread(userId, logProgress)
        console.log(`[BulkIngest/Worker] Phase 3 complete: ${p3.messagesProcessed} msgs, ${p3.conversationsCreated} convs, keys=[${getKeyUsageSummary()}]`)

        await publishBulkIngestStep({ ...job, step: 'phase4_classify' })
        return NextResponse.json({ ok: true, next: 'phase4_classify' })
      }

      case 'phase4_classify': {
        const logProgress = (p: Record<string, unknown>) =>
          console.log('[BulkIngest/Worker] Phase 4:', JSON.stringify(p))
        const p4 = await phase4Classify(userId, logProgress)
        console.log(`[BulkIngest/Worker] Phase 4 complete: ${p4.classified} classified, ${p4.classifyFailed} failed, keys=[${getKeyUsageSummary()}]`)

        await publishBulkIngestStep({ ...job, step: 'phase5_report' })
        return NextResponse.json({ ok: true, next: 'phase5_report', classified: p4.classified })
      }

      case 'phase5_report': {
        const effectiveUntil = job.until ? new Date(job.until) : new Date()
        const reportSent = await generateAndSendBackfillReport(
          userId,
          job.phase1Stats,
          job.filteredSenders,
          new Date(job.since),
          effectiveUntil,
        )
        console.log(`[BulkIngest/Worker] Phase 5 complete: report ${reportSent ? 'sent' : 'FAILED'}`)

        return NextResponse.json({ ok: true, done: true, reportSent })
      }

      default:
        return NextResponse.json({ error: `Unknown step: ${step}` }, { status: 400 })
    }
  } catch (error) {
    console.error(`[BulkIngest/Worker] Error in step ${step}:`, error)
    return NextResponse.json(
      { error: `Step ${step} failed`, details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    )
  }
}
