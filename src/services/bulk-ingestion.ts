/**
 * Bulk Ingestion Service
 * Historical email backfill in 5 phases:
 *   Phase 1: Fetch & store (filter + store only, no enrichment)
 *   Phase 2: Enrich + embed (enrichMessage + generateMessageEmbedding, 20 parallel)
 *   Phase 3: Thread conversations (chrono order, reuses existing threading)
 *   Phase 4: Classify (classifyEmail → update tag_primary/secondary, 20 parallel)
 *   Phase 5: Generate & send backfill report email (all data complete)
 *
 * This is a HISTORICAL BACKFILL — all ingested emails are assumed to be
 * already in the user's own process. No action proposals are generated.
 * Instead, a Mila welcome report is sent summarizing what was found.
 *
 * tag_primary='bulk_import' flows:
 *   Phase 1 sets it → Phase 2 enriches (tag unchanged) → Phase 3 threads
 *   (tag unchanged) → Phase 4 classifies (tag changes to real category)
 *   → Phase 5 reports on complete data.
 *
 * Streams progress via onProgress callback so the HTTP response starts
 * immediately and keeps the connection alive on long runs.
 */

import {
  fetchEmailsPaginated,
  extractEmailAddress,
  extractName,
  getUserEmail,
  GMAIL_SKIP_CATEGORIES,
} from '@/lib/google/gmail'
import type { EmailMessage } from '@/lib/google/gmail'
import { filterEmail, classifyEmail, enrichMessage } from '@/lib/ai/gemini'
import { findOrCreateCP, isSameGmailAddress, normalizeGmailAddress, purgeUserAsCp } from '@/lib/db/counterparties'
import { createMessage, messageExists, getUnprocessedMessages, updateMessage } from '@/lib/db/messages'
import { getUserById, upsertUser, getUserSettings } from '@/lib/db/users'
import { cleanMessageText, generateMessageEmbedding } from '@/lib/embeddings/generate'
import { saveMessageEmbedding } from '@/lib/db/embeddings'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { isBlockedSender } from './ingestion'
import { processMessagesForThreading } from './threading'
import { generateAndSendBackfillReport } from './backfill-report'
import { v4 as uuidv4 } from 'uuid'

export type ProgressCallback = (progress: Record<string, unknown>) => void

const CONCURRENCY = 20

// ─── Exported types for backfill-report.ts ──────────────────────────────────

export interface FilteredSender {
  email: string
  name: string | null
  count: number
  reason: string
}

export interface BulkIngestionPhase1Result {
  inboxFetched: number
  sentFetched: number
  skippedCategory: number
  skippedBlocked: number
  skippedFilter: number
  skippedDuplicate: number
  filterFailOpen: number
  stored: number
}

export interface Phase2EnrichResult {
  enriched: number
  enrichmentFailed: number
  embedded: number
  embeddingFailed: number
  errors: string[]
}

export interface Phase4ClassifyResult {
  classified: number
  classifyFailed: number
  errors: string[]
}

export interface BulkIngestionResult {
  phase1: BulkIngestionPhase1Result
  phase2: Phase2EnrichResult
  phase3: {
    messagesProcessed: number
    conversationsCreated: number
  }
  phase4: Phase4ClassifyResult
  report: {
    sent: boolean
    error?: string
  }
  errors: string[]
}

// ─── Shared Helpers (used by both runBulkIngestion and QStash worker) ────────

/**
 * Track a filtered sender in the accumulator array.
 * Used across QStash hops to accumulate filtered sender data.
 */
export function trackFilteredSender(
  senders: FilteredSender[],
  email: string,
  name: string | null,
  reason: string
): void {
  const key = email.toLowerCase()
  const existing = senders.find(s => s.email === key)
  if (existing) {
    existing.count++
  } else {
    senders.push({ email: key, name, count: 1, reason })
  }
}

/**
 * Process a batch of emails: dedup, filter, store (no enrichment).
 * Used by the QStash worker for Phase 1 batches.
 * Mutates stats, filteredSenders, and errors in place.
 * Processes up to CONCURRENCY=20 emails in parallel.
 */
export async function processEmailBatch(
  userId: string,
  userEmail: string,
  emails: EmailMessage[],
  stats: BulkIngestionPhase1Result,
  filteredSenders: FilteredSender[],
  errors: string[],
): Promise<void> {
  const totalEmails = emails.length
  console.log(`[BulkIngest] Batch start: ${totalEmails} emails to process`)

  const trackFiltered = (email: string, name: string | null, reason: string) => {
    trackFilteredSender(filteredSenders, email, name, reason)
  }

  for (let i = 0; i < totalEmails; i += CONCURRENCY) {
    const chunk = emails.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(email => processOneEmailForStore(userId, userEmail, email, stats, trackFiltered))
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        const errMsg = result.reason instanceof Error ? result.reason.message : 'Unknown'
        console.error(`[BulkIngest] Email processing failed:`, result.reason)
        errors.push(`Email batch: ${errMsg}`)
      }
    }
  }

  console.log(`[BulkIngest] Batch done: stored=${stats.stored} skipped=${stats.skippedCategory + stats.skippedBlocked + stats.skippedFilter + stats.skippedDuplicate}`)
}

/**
 * Process a single email for Phase 1: dedup → category check → blocked check
 * → AI filter → find/create CP → store. No enrichment.
 * Used by both QStash worker (processEmailBatch) and local pipeline (phase1FetchAndStore).
 * Mutates stats in place (safe for allSettled — each email increments different counters).
 */
async function processOneEmailForStore(
  userId: string,
  userEmail: string,
  email: EmailMessage,
  stats: BulkIngestionPhase1Result,
  trackFiltered: (email: string, name: string | null, reason: string) => void,
): Promise<void> {
  if (await messageExists(userId, email.id)) {
    stats.skippedDuplicate++
    return
  }

  if (email.labels.some(l => GMAIL_SKIP_CATEGORIES.includes(l))) {
    stats.skippedCategory++
    const senderAddr = extractEmailAddress(email.from)
    trackFiltered(senderAddr, extractName(email.from), 'Kategorie Gmail')
    return
  }

  const senderEmail = extractEmailAddress(email.from)
  const isOutbound = isSameGmailAddress(senderEmail, userEmail)
  const direction = isOutbound ? 'outbound' : 'inbound'

  let cpEmail: string
  let cpName: string | null
  if (isOutbound) {
    if (!email.to || email.to.length === 0) return
    cpEmail = extractEmailAddress(email.to[0])
    cpName = extractName(email.to[0])
  } else {
    cpEmail = senderEmail
    cpName = extractName(email.from)
  }

  if (isSameGmailAddress(cpEmail, userEmail)) return

  if (isBlockedSender(cpEmail)) {
    stats.skippedBlocked++
    trackFiltered(cpEmail, cpName, 'Blokovaný odesílatel')
    return
  }

  // Skip empty/near-empty messages — nothing to enrich, embed, or act on
  const cleanedBody = cleanMessageText(email.body, 'email').slice(0, 5000)
  if (cleanedBody.trim().length < 20) return

  try {
    const filter = await filterEmail(email.subject, email.body, email.from)
    if (!filter.relevant) {
      stats.skippedFilter++
      trackFiltered(cpEmail, cpName, 'Automatický / nerelevantní')
      return
    }
  } catch {
    stats.filterFailOpen++
  }

  const cp = await findOrCreateCP(userId, cpEmail, cpName || undefined)
  if (!cp) return

  const messageId = uuidv4()
  await createMessage({
    id: messageId,
    user_id: userId,
    cp_id: cp.id,
    external_id: email.id,
    external_thread_id: email.threadId,
    universal_message_id: email.id,
    direction,
    raw_text: email.body,
    cleaned_text: cleanedBody,
    tag_primary: 'bulk_import',
    tag_secondary: null,
    timestamp: email.date.toISOString(),
    occurred_at: email.date.toISOString(),
  })

  stats.stored++
  console.log(`[BulkIngest] ${direction} ${email.id} cp=${cpEmail}`)
}

// ─── Phase 1: Fetch & Store ─────────────────────────────────────────────────

interface Phase1InternalResult extends BulkIngestionPhase1Result {
  filteredSenders: FilteredSender[]
  errors: string[]
}

/**
 * Phase 1: Fetch & Store
 * Paginated fetch from INBOX + SENT (in parallel), filter, store raw messages.
 * No enrichment — that's Phase 2.
 * Tracks filtered senders for the backfill report.
 */
async function phase1FetchAndStore(
  userId: string,
  since: Date,
  until: Date | undefined,
  maxTotal: number,
  onProgress: ProgressCallback
): Promise<Phase1InternalResult> {
  const stats: Phase1InternalResult = {
    inboxFetched: 0,
    sentFetched: 0,
    skippedCategory: 0,
    skippedBlocked: 0,
    skippedFilter: 0,
    skippedDuplicate: 0,
    filterFailOpen: 0,
    stored: 0,
    filteredSenders: [],
    errors: [],
  }

  // Accumulate filtered senders for the report
  const filteredMap = new Map<string, FilteredSender>()
  const trackFiltered = (email: string, name: string | null, reason: string) => {
    const key = normalizeGmailAddress(email)
    const existing = filteredMap.get(key)
    if (existing) {
      existing.count++
    } else {
      filteredMap.set(key, { email: key, name, count: 1, reason })
    }
  }

  // Get user email for direction detection
  let userEmail: string
  try {
    const user = await getUserById(userId)
    if (!user) throw new Error(`User not found: ${userId}`)

    if (!user.email) {
      const emailFromGmail = await getUserEmail(userId)
      if (emailFromGmail) {
        await upsertUser({ ...user, email: emailFromGmail })
        userEmail = normalizeGmailAddress(emailFromGmail)
      } else {
        throw new Error(`User ${userId} has no email address`)
      }
    } else {
      userEmail = normalizeGmailAddress(user.email)
    }
  } catch (error) {
    stats.errors.push(`User setup: ${error instanceof Error ? error.message : 'Unknown'}`)
    return stats
  }

  onProgress({ phase: 1, step: 'user_resolved', userEmail })
  console.log(`[BulkIngest] Phase 1: User resolved — ${userEmail}`)

  // Purge user-as-CP
  await purgeUserAsCp(userId)

  // Fetch INBOX + SENT in parallel
  onProgress({ phase: 1, step: 'fetching' })
  console.log(`[BulkIngest] Phase 1: Fetching emails since ${since.toISOString()}`)

  const [inboxEmails, sentEmails] = await Promise.all([
    fetchEmailsPaginated(userId, {
      query: '-in:spam -in:trash -in:sent -in:draft',
      after: since,
      before: until,
      maxTotal,
    }),
    fetchEmailsPaginated(userId, {
      query: 'in:sent',
      after: since,
      before: until,
      maxTotal,
    }),
  ])

  stats.inboxFetched = inboxEmails.length
  stats.sentFetched = sentEmails.length
  onProgress({ phase: 1, step: 'fetched', inbox: inboxEmails.length, sent: sentEmails.length })

  // Combine and sort chronologically
  const allEmails = [...inboxEmails, ...sentEmails]
    .sort((a, b) => a.date.getTime() - b.date.getTime())

  onProgress({ phase: 1, step: 'processing_emails', total: allEmails.length })

  // Process emails in parallel batches of CONCURRENCY
  for (let i = 0; i < allEmails.length; i += CONCURRENCY) {
    const chunk = allEmails.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(email => processOneEmailForStore(userId, userEmail, email, stats, trackFiltered))
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`[BulkIngest] Phase 1 email error:`, result.reason)
        stats.errors.push(`Email: ${result.reason instanceof Error ? result.reason.message : 'Unknown'}`)
      }
    }

    // Stream progress per batch
    onProgress({
      phase: 1, step: 'stored', processed: Math.min(i + CONCURRENCY, allEmails.length), total: allEmails.length,
      stored: stats.stored,
      skipped: stats.skippedCategory + stats.skippedBlocked + stats.skippedFilter + stats.skippedDuplicate,
    })
  }

  // Finalize filtered senders list, sorted by count desc
  stats.filteredSenders = Array.from(filteredMap.values())
    .sort((a, b) => b.count - a.count)

  console.log(`\n[BulkIngest] Phase 1 complete:`)
  console.log(`[BulkIngest]   Inbox fetched:  ${stats.inboxFetched}`)
  console.log(`[BulkIngest]   Sent fetched:   ${stats.sentFetched}`)
  console.log(`[BulkIngest]   Stored:         ${stats.stored}`)
  console.log(`[BulkIngest]   Skipped:`)
  console.log(`[BulkIngest]     Category:     ${stats.skippedCategory}`)
  console.log(`[BulkIngest]     Blocked:      ${stats.skippedBlocked}`)
  console.log(`[BulkIngest]     Filter:       ${stats.skippedFilter}`)
  console.log(`[BulkIngest]     Duplicate:    ${stats.skippedDuplicate}`)
  if (stats.filterFailOpen > 0) {
    console.log(`[BulkIngest]     Filter fail-open: ${stats.filterFailOpen} (AI unavailable, allowed through)`)
  }
  console.log(`[BulkIngest]   Filtered senders: ${stats.filteredSenders.length} unique`)
  onProgress({ phase: 1, step: 'complete', ...stats, filteredSenders: stats.filteredSenders.length })
  return stats
}

// ─── Phase 2: Enrich + Embed ────────────────────────────────────────────────

/**
 * Phase 2: Enrich + Embed
 * Query all bulk_import messages with enriched_text IS NULL.
 * Parallel batches of 20: enrichMessage → updateMessage → generateMessageEmbedding → saveMessageEmbedding.
 */
export async function phase2Enrich(
  userId: string,
  onProgress: ProgressCallback,
  settings?: import('@/lib/supabase/types').UserSettings | null,
): Promise<Phase2EnrichResult> {
  console.log(`[BulkIngest] Phase 2: Enriching stored messages`)
  onProgress({ phase: 2, step: 'loading_unenriched' })

  const result: Phase2EnrichResult = {
    enriched: 0,
    enrichmentFailed: 0,
    embedded: 0,
    embeddingFailed: 0,
    errors: [],
  }

  const supabase = getSupabaseAdmin()
  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .eq('tag_primary', 'bulk_import')
    .is('enriched_text', null)
    .order('timestamp', { ascending: true })

  if (error) {
    result.errors.push(`Failed to query unenriched messages: ${error.message}`)
    return result
  }

  if (!messages || messages.length === 0) {
    console.log(`[BulkIngest] Phase 2: No unenriched messages found`)
    onProgress({ phase: 2, step: 'complete', enriched: 0, enrichmentFailed: 0 })
    return result
  }

  console.log(`[BulkIngest] Phase 2: ${messages.length} messages to enrich`)
  onProgress({ phase: 2, step: 'enriching', total: messages.length })

  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const chunk = messages.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(async (msg) => {
        const bodyText = msg.cleaned_text || msg.raw_text || ''
        if (!bodyText) return

        const direction = (msg.direction as 'inbound' | 'outbound') || 'inbound'
        const enrichedText = await enrichMessage(bodyText, 'email', direction, undefined, settings ?? undefined)
        await updateMessage(msg.id, { enriched_text: enrichedText })
        result.enriched++

        try {
          const embedding = await generateMessageEmbedding(enrichedText, 'email', true)
          await saveMessageEmbedding(msg.id, embedding)
          result.embedded++
        } catch (embError) {
          result.embeddingFailed++
          console.error(`[BulkIngest] Phase 2: Embedding failed for ${msg.id}:`, embError)
        }
      })
    )

    for (const r of results) {
      if (r.status === 'rejected') {
        result.enrichmentFailed++
        console.error(`[BulkIngest] Phase 2: Enrichment failed:`, r.reason)
        result.errors.push(`Enrich: ${r.reason instanceof Error ? r.reason.message : 'Unknown'}`)
      }
    }

    onProgress({
      phase: 2, step: 'enriching', processed: Math.min(i + CONCURRENCY, messages.length), total: messages.length,
      enriched: result.enriched, enrichmentFailed: result.enrichmentFailed,
      embedded: result.embedded, embeddingFailed: result.embeddingFailed,
    })
  }

  console.log(`\n[BulkIngest] Phase 2 complete:`)
  console.log(`[BulkIngest]   Enriched:    ${result.enriched}`)
  console.log(`[BulkIngest]   Enrich failed: ${result.enrichmentFailed}`)
  console.log(`[BulkIngest]   Embedded:    ${result.embedded}`)
  console.log(`[BulkIngest]   Embed failed: ${result.embeddingFailed}`)
  onProgress({ phase: 2, step: 'complete', ...result })

  return result
}

// ─── Phase 3: Thread ────────────────────────────────────────────────────────

/**
 * Phase 3: Thread
 * Get all unprocessed messages (sorted chrono), run existing threading.
 */
export async function phase3Thread(
  userId: string,
  onProgress: ProgressCallback
): Promise<BulkIngestionResult['phase3'] & { conversationIds: string[] }> {
  console.log(`[BulkIngest] Phase 3: Threading messages`)
  onProgress({ phase: 3, step: 'loading_unprocessed' })

  const BATCH_SIZE = 1000
  let totalProcessed = 0
  const allConversationIds = new Set<string>()

  while (true) {
    const unprocessed = await getUnprocessedMessages(userId, BATCH_SIZE)
    if (unprocessed.length === 0) break

    console.log(`[BulkIngest] Phase 3: Threading batch of ${unprocessed.length} messages (total so far: ${totalProcessed})`)
    onProgress({ phase: 3, step: 'threading', batchSize: unprocessed.length, totalProcessed })

    const conversations = await processMessagesForThreading(unprocessed)

    for (const id of conversations.keys()) {
      allConversationIds.add(id)
    }
    totalProcessed += unprocessed.length

    if (unprocessed.length < BATCH_SIZE) break
  }

  const conversationIds = Array.from(allConversationIds)
  console.log(`\n[BulkIngest] Phase 3 complete:`)
  console.log(`[BulkIngest]   Messages threaded:    ${totalProcessed}`)
  console.log(`[BulkIngest]   Conversations created: ${conversationIds.length}`)
  onProgress({ phase: 3, step: 'complete', messagesProcessed: totalProcessed, conversationsCreated: conversationIds.length })

  return {
    messagesProcessed: totalProcessed,
    conversationsCreated: conversationIds.length,
    conversationIds,
  }
}

// ─── Phase 4: Classify ──────────────────────────────────────────────────────

/**
 * Phase 4: Classify
 * Classify all messages still tagged 'bulk_import' → update tag_primary/secondary.
 * Parallel batches of 20. No enrichment, no embedding (Phase 2 did it).
 * After classification, tag_primary changes from 'bulk_import' to the real category.
 */
export async function phase4Classify(
  userId: string,
  onProgress: ProgressCallback,
): Promise<Phase4ClassifyResult> {
  console.log(`[BulkIngest] Phase 4: Classifying stored messages`)
  onProgress({ phase: 4, step: 'loading_unclassified' })

  const result: Phase4ClassifyResult = {
    classified: 0,
    classifyFailed: 0,
    errors: [],
  }

  const supabase = getSupabaseAdmin()
  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, raw_text, cleaned_text, enriched_text')
    .eq('user_id', userId)
    .eq('tag_primary', 'bulk_import')
    .order('timestamp', { ascending: true })

  if (error) {
    result.errors.push(`Failed to query unclassified messages: ${error.message}`)
    return result
  }

  if (!messages || messages.length === 0) {
    console.log(`[BulkIngest] Phase 4: No unclassified messages found`)
    onProgress({ phase: 4, step: 'complete', classified: 0, classifyFailed: 0 })
    return result
  }

  console.log(`[BulkIngest] Phase 4: ${messages.length} messages to classify`)
  onProgress({ phase: 4, step: 'classifying', total: messages.length })

  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const chunk = messages.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(async (msg) => {
        const bodyText = msg.enriched_text || msg.cleaned_text || msg.raw_text || ''
        const classification = await classifyEmail('', bodyText, '')
        await updateMessage(msg.id, {
          tag_primary: classification.category,
          tag_secondary: null,
        })
        result.classified++
      })
    )

    for (const r of results) {
      if (r.status === 'rejected') {
        result.classifyFailed++
        console.error(`[BulkIngest] Phase 4: Classification failed:`, r.reason)
        result.errors.push(`Classify: ${r.reason instanceof Error ? r.reason.message : 'Unknown'}`)
      }
    }

    onProgress({
      phase: 4, step: 'classifying', processed: Math.min(i + CONCURRENCY, messages.length), total: messages.length,
      classified: result.classified, classifyFailed: result.classifyFailed,
    })
  }

  console.log(`\n[BulkIngest] Phase 4 complete:`)
  console.log(`[BulkIngest]   Classified:  ${result.classified}`)
  console.log(`[BulkIngest]   Failed:      ${result.classifyFailed}`)
  onProgress({ phase: 4, step: 'complete', classified: result.classified, classifyFailed: result.classifyFailed })

  return result
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

/**
 * Run the full bulk ingestion pipeline.
 * Phase 1: Fetch & store (filter only, no enrichment)
 * Phase 2: Enrich + embed (20 parallel)
 * Phase 3: Thread conversations
 * Phase 4: Classify (20 parallel, replaces bulk_import tag)
 * Phase 5: Generate & send backfill report (all data complete)
 * Streams progress via onProgress callback.
 */
export async function runBulkIngestion(
  userId: string,
  since: Date,
  until?: Date,
  maxTotal: number = 500,
  onProgress: ProgressCallback = () => {}
): Promise<BulkIngestionResult> {
  const result: BulkIngestionResult = {
    phase1: {
      inboxFetched: 0,
      sentFetched: 0,
      skippedCategory: 0,
      skippedBlocked: 0,
      skippedFilter: 0,
      skippedDuplicate: 0,
      filterFailOpen: 0,
      stored: 0,
    },
    phase2: {
      enriched: 0,
      enrichmentFailed: 0,
      embedded: 0,
      embeddingFailed: 0,
      errors: [],
    },
    phase3: {
      messagesProcessed: 0,
      conversationsCreated: 0,
    },
    phase4: {
      classified: 0,
      classifyFailed: 0,
      errors: [],
    },
    report: {
      sent: false,
    },
    errors: [],
  }

  // Phase 1: Fetch & Store
  const p1 = await phase1FetchAndStore(userId, since, until, maxTotal, onProgress)
  result.phase1 = {
    inboxFetched: p1.inboxFetched,
    sentFetched: p1.sentFetched,
    skippedCategory: p1.skippedCategory,
    skippedBlocked: p1.skippedBlocked,
    skippedFilter: p1.skippedFilter,
    skippedDuplicate: p1.skippedDuplicate,
    filterFailOpen: p1.filterFailOpen,
    stored: p1.stored,
  }
  result.errors.push(...p1.errors)

  if (p1.stored === 0 && p1.errors.length > 0) {
    return result
  }

  // Phase 2: Enrich + Embed
  const bulkSettings = await getUserSettings(userId)
  const p2 = await phase2Enrich(userId, onProgress, bulkSettings)
  result.phase2 = p2
  result.errors.push(...p2.errors)

  // Phase 3: Thread (after enrichment so embeddings are available)
  const p3 = await phase3Thread(userId, onProgress)
  result.phase3 = {
    messagesProcessed: p3.messagesProcessed,
    conversationsCreated: p3.conversationsCreated,
  }

  // Phase 4: Classify (replaces bulk_import tag with real category)
  const p4 = await phase4Classify(userId, onProgress)
  result.phase4 = p4
  result.errors.push(...p4.errors)

  // Phase 5: Generate & send backfill report (all data complete)
  console.log(`[BulkIngest] Phase 5: Generating backfill report`)
  onProgress({ phase: 5, step: 'generating_report' })

  const effectiveUntil = until || new Date()
  const reportResult = await generateAndSendBackfillReport(
    userId,
    result.phase1,
    p1.filteredSenders,
    since,
    effectiveUntil
  )
  result.report = reportResult
  if (reportResult.error) {
    result.errors.push(`Backfill report: ${reportResult.error}`)
  }

  console.log(`[BulkIngest] Phase 5 complete: report ${reportResult.sent ? 'sent' : 'FAILED'}${reportResult.error ? ` — ${reportResult.error}` : ''}`)
  onProgress({ phase: 5, step: 'complete', reportSent: reportResult.sent, reportError: reportResult.error })

  return result
}
