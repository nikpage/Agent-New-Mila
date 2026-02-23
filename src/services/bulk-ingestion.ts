/**
 * Bulk Ingestion Service
 * Historical email backfill in 4 phases:
 *   Phase 1: Fetch & store (paginated, pre-filter only, no embeddings)
 *   Phase 2: Thread conversations (chrono order, reuses existing threading)
 *   Phase 3: Generate & send backfill report email
 *   Phase 4: Enrich stored messages (classify + embed) — runs AFTER report
 *
 * This is a HISTORICAL BACKFILL — all ingested emails are assumed to be
 * already in the user's own process. No action proposals are generated.
 * Instead, a Mila welcome report is sent summarizing what was found.
 *
 * Phase 4 runs after the report so the user gets their backfill summary
 * even if enrichment exceeds Vercel's maxDuration. Enrichment is resumable:
 * unenriched messages keep tag_primary = 'bulk_import' and can be retried.
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
import { preFilterEmail, classifyEmail } from '@/lib/ai/gemini'
import { probeAIAvailability } from '@/lib/ai/runner'
import { findOrCreateCP, isSameGmailAddress } from '@/lib/db/counterparties'
import { createMessage, messageExists, getUnprocessedMessages, updateMessage } from '@/lib/db/messages'
import { getUserById, upsertUser } from '@/lib/db/users'
import { generateMessageEmbedding } from '@/lib/embeddings/generate'
import { saveMessageEmbedding } from '@/lib/db/embeddings'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { isBlockedSender } from './ingestion'
import { processMessagesForThreading } from './threading'
import { generateAndSendBackfillReport } from './backfill-report'
import { purgeUserAsCp } from '@/lib/db/counterparties'
import { v4 as uuidv4 } from 'uuid'

export type ProgressCallback = (progress: Record<string, unknown>) => void

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
  skippedPreFilter: number
  skippedDuplicate: number
  stored: number
}

export interface BulkIngestionResult {
  phase1: BulkIngestionPhase1Result
  phase2: {
    messagesProcessed: number
    conversationsCreated: number
  }
  report: {
    sent: boolean
  }
  enrichment: {
    enriched: number
    enrichmentFailed: number
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
 * Process a batch of emails: dedup, filter, preFilter AI, store.
 * Used by the QStash worker for Phase 1 batches.
 * Mutates stats, filteredSenders, and errors in place.
 */
export async function processEmailBatch(
  userId: string,
  userEmail: string,
  emails: EmailMessage[],
  stats: BulkIngestionPhase1Result,
  filteredSenders: FilteredSender[],
  errors: string[],
): Promise<void> {
  for (const email of emails) {
    try {
      if (await messageExists(userId, email.id)) {
        stats.skippedDuplicate++
        continue
      }

      if (email.labels.some(l => GMAIL_SKIP_CATEGORIES.includes(l))) {
        stats.skippedCategory++
        const senderAddr = extractEmailAddress(email.from)
        trackFilteredSender(filteredSenders, senderAddr, extractName(email.from), 'Kategorie Gmail')
        continue
      }

      const senderEmail = extractEmailAddress(email.from)
      const isOutbound = isSameGmailAddress(senderEmail, userEmail)
      const direction = isOutbound ? 'outbound' : 'inbound'

      let cpEmail: string
      let cpName: string | null
      if (isOutbound) {
        if (!email.to || email.to.length === 0) continue
        cpEmail = extractEmailAddress(email.to[0])
        cpName = extractName(email.to[0])
      } else {
        cpEmail = senderEmail
        cpName = extractName(email.from)
      }

      if (isSameGmailAddress(cpEmail, userEmail)) continue

      if (isBlockedSender(cpEmail)) {
        stats.skippedBlocked++
        trackFilteredSender(filteredSenders, cpEmail, cpName, 'Blokovaný odesílatel')
        continue
      }

      try {
        const filter = await preFilterEmail(email.subject, email.body, email.from)
        if (!filter.relevant) {
          stats.skippedPreFilter++
          trackFilteredSender(filteredSenders, cpEmail, cpName, 'Automatický / nerelevantní')
          continue
        }
      } catch (error) {
        console.error(`[BulkIngest] Pre-filter failed for ${email.id}, allowing:`, error)
      }

      const cp = await findOrCreateCP(userId, cpEmail, cpName || undefined)
      if (!cp) continue

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
        cleaned_text: email.body.slice(0, 5000),
        tag_primary: 'bulk_import',
        tag_secondary: null,
        timestamp: email.date.toISOString(),
        occurred_at: email.date.toISOString(),
      })

      stats.stored++
    } catch (error) {
      console.error(`[BulkIngest] Error processing email ${email.id}:`, error)
      errors.push(`Email ${email.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
  }
}

// ─── Phase 1: Fetch & Store ─────────────────────────────────────────────────

interface Phase1InternalResult extends BulkIngestionPhase1Result {
  filteredSenders: FilteredSender[]
  errors: string[]
}

/**
 * Phase 1: Fetch & Store
 * Paginated fetch from INBOX + SENT, pre-filter, store raw messages.
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
    skippedPreFilter: 0,
    skippedDuplicate: 0,
    stored: 0,
    filteredSenders: [],
    errors: [],
  }

  // Accumulate filtered senders for the report
  const filteredMap = new Map<string, FilteredSender>()
  const trackFiltered = (email: string, name: string | null, reason: string) => {
    const key = email.toLowerCase()
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
        userEmail = emailFromGmail.toLowerCase()
      } else {
        throw new Error(`User ${userId} has no email address`)
      }
    } else {
      userEmail = user.email.toLowerCase()
    }
  } catch (error) {
    stats.errors.push(`User setup: ${error instanceof Error ? error.message : 'Unknown'}`)
    return stats
  }

  onProgress({ phase: 1, step: 'user_resolved', userEmail })
  console.log(`[BulkIngest] Phase 1: User resolved — ${userEmail}`)

  // Purge user-as-CP
  await purgeUserAsCp(userId)

  // Fetch received emails (not just INBOX — includes archived/read)
  onProgress({ phase: 1, step: 'fetching_inbox' })
  console.log(`[BulkIngest] Phase 1: Fetching received emails since ${since.toISOString()}`)
  const inboxEmails = await fetchEmailsPaginated(userId, {
    query: '-in:spam -in:trash -in:sent -in:draft',
    after: since,
    before: until,
    maxTotal,
  })
  stats.inboxFetched = inboxEmails.length
  onProgress({ phase: 1, step: 'inbox_fetched', count: inboxEmails.length })

  // Fetch SENT emails
  onProgress({ phase: 1, step: 'fetching_sent' })
  console.log(`[BulkIngest] Phase 1: Fetching SENT emails since ${since.toISOString()}`)
  const sentEmails = await fetchEmailsPaginated(userId, {
    query: 'in:sent',
    after: since,
    before: until,
    maxTotal,
  })
  stats.sentFetched = sentEmails.length
  onProgress({ phase: 1, step: 'sent_fetched', count: sentEmails.length })

  // Combine and sort chronologically
  const allEmails = [...inboxEmails, ...sentEmails]
    .sort((a, b) => a.date.getTime() - b.date.getTime())

  onProgress({ phase: 1, step: 'processing_emails', total: allEmails.length })

  // Process each email
  for (let i = 0; i < allEmails.length; i++) {
    const email = allEmails[i]
    try {
      // Dedup
      if (await messageExists(userId, email.id)) {
        stats.skippedDuplicate++
        continue
      }

      // Skip Gmail categories (promotions, social, updates, forums)
      if (email.labels.some(l => GMAIL_SKIP_CATEGORIES.includes(l))) {
        stats.skippedCategory++
        const senderAddr = extractEmailAddress(email.from)
        trackFiltered(senderAddr, extractName(email.from), 'Kategorie Gmail')
        continue
      }

      // Determine direction
      const senderEmail = extractEmailAddress(email.from)
      const isOutbound = isSameGmailAddress(senderEmail, userEmail)
      const direction = isOutbound ? 'outbound' : 'inbound'

      // Get the counterparty email
      let cpEmail: string
      let cpName: string | null
      if (isOutbound) {
        if (!email.to || email.to.length === 0) continue
        cpEmail = extractEmailAddress(email.to[0])
        cpName = extractName(email.to[0])
      } else {
        cpEmail = senderEmail
        cpName = extractName(email.from)
      }

      // Skip if CP is the user themselves
      if (isSameGmailAddress(cpEmail, userEmail)) continue

      // Blocked sender check (free)
      if (isBlockedSender(cpEmail)) {
        stats.skippedBlocked++
        trackFiltered(cpEmail, cpName, 'Blokovaný odesílatel')
        continue
      }

      // Pre-filter (cheap AI call)
      try {
        const filter = await preFilterEmail(email.subject, email.body, email.from)
        if (!filter.relevant) {
          stats.skippedPreFilter++
          trackFiltered(cpEmail, cpName, 'Automatický / nerelevantní')
          continue
        }
      } catch (error) {
        // If pre-filter fails, let the email through (fail open)
        console.error(`[BulkIngest] Pre-filter failed for ${email.id}, allowing:`, error)
      }

      // Find or create CP
      const cp = await findOrCreateCP(userId, cpEmail, cpName || undefined)
      if (!cp) continue

      // Store message
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
        cleaned_text: email.body.slice(0, 5000),
        tag_primary: 'bulk_import',
        tag_secondary: null,
        timestamp: email.date.toISOString(),
        occurred_at: email.date.toISOString(),
      })

      stats.stored++

      // Stream progress every 5 emails
      if ((i + 1) % 5 === 0 || i === allEmails.length - 1) {
        onProgress({
          phase: 1,
          step: 'storing',
          processed: i + 1,
          total: allEmails.length,
          stored: stats.stored,
          skipped: stats.skippedCategory + stats.skippedBlocked + stats.skippedPreFilter + stats.skippedDuplicate,
        })
      }
    } catch (error) {
      console.error(`[BulkIngest] Error processing email ${email.id}:`, error)
      stats.errors.push(`Email ${email.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }
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
  console.log(`[BulkIngest]     Pre-filter:   ${stats.skippedPreFilter}`)
  console.log(`[BulkIngest]     Duplicate:    ${stats.skippedDuplicate}`)
  console.log(`[BulkIngest]   Filtered senders: ${stats.filteredSenders.length} unique`)
  onProgress({ phase: 1, step: 'complete', ...stats, filteredSenders: stats.filteredSenders.length })
  return stats
}

// ─── Phase 2: Thread ────────────────────────────────────────────────────────

/**
 * Phase 2: Thread
 * Get all unprocessed messages (sorted chrono), run existing threading.
 */
export async function phase2Thread(
  userId: string,
  onProgress: ProgressCallback
): Promise<BulkIngestionResult['phase2'] & { conversationIds: string[] }> {
  console.log(`[BulkIngest] Phase 2: Threading messages`)
  onProgress({ phase: 2, step: 'loading_unprocessed' })

  const BATCH_SIZE = 1000
  let totalProcessed = 0
  const allConversationIds = new Set<string>()

  // Loop in batches until all unprocessed messages are threaded
  while (true) {
    const unprocessed = await getUnprocessedMessages(userId, BATCH_SIZE)
    if (unprocessed.length === 0) break

    console.log(`[BulkIngest] Phase 2: Threading batch of ${unprocessed.length} messages (total so far: ${totalProcessed})`)
    onProgress({ phase: 2, step: 'threading', batchSize: unprocessed.length, totalProcessed })

    // processMessagesForThreading handles:
    // - external_thread_id matching (free, instant)
    // - embedding similarity (fallback)
    // - new conversation creation
    // - conversation summary rebuilds
    const conversations = await processMessagesForThreading(unprocessed)

    for (const id of conversations.keys()) {
      allConversationIds.add(id)
    }
    totalProcessed += unprocessed.length

    // If we got fewer than BATCH_SIZE, we've processed everything
    if (unprocessed.length < BATCH_SIZE) break
  }

  const conversationIds = Array.from(allConversationIds)
  console.log(`\n[BulkIngest] Phase 2 complete:`)
  console.log(`[BulkIngest]   Messages threaded:    ${totalProcessed}`)
  console.log(`[BulkIngest]   Conversations created: ${conversationIds.length}`)
  onProgress({ phase: 2, step: 'complete', messagesProcessed: totalProcessed, conversationsCreated: conversationIds.length })

  return {
    messagesProcessed: totalProcessed,
    conversationsCreated: conversationIds.length,
    conversationIds,
  }
}

// ─── Phase 4: Enrich ────────────────────────────────────────────────────────

export interface Phase4Result {
  enriched: number
  enrichmentFailed: number
  errors: string[]
}

/**
 * Phase 4: Enrich
 * Classify and embed all messages that were stored in Phase 1 but not yet enriched.
 * Runs AFTER the backfill report (Phase 3) so the user gets their summary even
 * if enrichment times out on Vercel.
 *
 * Unenriched messages are identified by tag_primary = 'bulk_import'.
 * After enrichment, tag_primary is updated to the classification category.
 * This makes enrichment resumable — if the function is killed mid-run,
 * remaining messages still have tag_primary = 'bulk_import' and can be retried.
 */
export async function phase4Enrich(
  userId: string,
  onProgress: ProgressCallback
): Promise<Phase4Result> {
  console.log(`[BulkIngest] Phase 4: Enriching stored messages`)
  onProgress({ phase: 4, step: 'loading_unenriched' })

  const result: Phase4Result = {
    enriched: 0,
    enrichmentFailed: 0,
    errors: [],
  }

  // Query messages that were stored in Phase 1 but not yet enriched
  const supabase = getSupabaseAdmin()
  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId)
    .eq('tag_primary', 'bulk_import')
    .order('timestamp', { ascending: true })

  if (error) {
    result.errors.push(`Failed to query unenriched messages: ${error.message}`)
    return result
  }

  if (!messages || messages.length === 0) {
    console.log(`[BulkIngest] Phase 4: No unenriched messages found`)
    onProgress({ phase: 4, step: 'complete', enriched: 0, enrichmentFailed: 0 })
    return result
  }

  console.log(`[BulkIngest] Phase 4: ${messages.length} messages to enrich`)
  onProgress({ phase: 4, step: 'enriching', total: messages.length })

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    try {
      const bodyText = msg.raw_text || msg.cleaned_text || ''

      // Classify the email (subject/from not stored separately — body is the primary signal)
      const classification = await classifyEmail('', bodyText, '')

      // Update message with classification results (replaces 'bulk_import' tag)
      await updateMessage(msg.id, {
        tag_primary: classification.category,
        tag_secondary: classification.priority,
      })

      // Generate and save embedding (non-fatal if it fails)
      try {
        if (bodyText) {
          const embedding = await generateMessageEmbedding(bodyText)
          await saveMessageEmbedding(msg.id, embedding)
        }
      } catch (embError) {
        console.error(`[BulkIngest] Phase 4: Embedding failed for ${msg.id}:`, embError)
        // Embedding failure is non-fatal — classification still succeeded
      }

      result.enriched++
    } catch (error) {
      console.error(`[BulkIngest] Phase 4: Enrichment failed for ${msg.id}:`, error)
      result.enrichmentFailed++
      result.errors.push(`Enrich ${msg.id}: ${error instanceof Error ? error.message : 'Unknown'}`)
    }

    // Stream progress every 5 messages
    if ((i + 1) % 5 === 0 || i === messages.length - 1) {
      onProgress({
        phase: 4,
        step: 'enriching',
        processed: i + 1,
        total: messages.length,
        enriched: result.enriched,
        enrichmentFailed: result.enrichmentFailed,
      })
    }
  }

  console.log(`\n[BulkIngest] Phase 4 complete:`)
  console.log(`[BulkIngest]   Enriched:    ${result.enriched}`)
  console.log(`[BulkIngest]   Failed:      ${result.enrichmentFailed}`)
  onProgress({ phase: 4, step: 'complete', enriched: result.enriched, enrichmentFailed: result.enrichmentFailed })

  return result
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

/**
 * Run the full bulk ingestion pipeline.
 * Phase 1 completes entirely before Phase 2 starts.
 * Phase 2 completes entirely before Phase 3 starts.
 * Phase 3 sends the backfill report (no action proposals).
 * Phase 4 enriches stored messages (classify + embed) — runs AFTER report.
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
      skippedPreFilter: 0,
      skippedDuplicate: 0,
      stored: 0,
    },
    phase2: {
      messagesProcessed: 0,
      conversationsCreated: 0,
    },
    report: {
      sent: false,
    },
    enrichment: {
      enriched: 0,
      enrichmentFailed: 0,
    },
    errors: [],
  }

  // Probe AI availability once — skip Gemini for this run if it's geo-blocked
  await probeAIAvailability()

  // Phase 1: Fetch & Store
  const p1 = await phase1FetchAndStore(userId, since, until, maxTotal, onProgress)
  result.phase1 = {
    inboxFetched: p1.inboxFetched,
    sentFetched: p1.sentFetched,
    skippedCategory: p1.skippedCategory,
    skippedBlocked: p1.skippedBlocked,
    skippedPreFilter: p1.skippedPreFilter,
    skippedDuplicate: p1.skippedDuplicate,
    stored: p1.stored,
  }
  result.errors.push(...p1.errors)

  if (p1.stored === 0 && p1.errors.length > 0) {
    return result
  }

  // Phase 2: Thread (after ALL messages stored)
  const p2 = await phase2Thread(userId, onProgress)
  result.phase2 = {
    messagesProcessed: p2.messagesProcessed,
    conversationsCreated: p2.conversationsCreated,
  }

  // Phase 3: Generate & send backfill report (replaces action proposals)
  console.log(`[BulkIngest] Phase 3: Generating backfill report`)
  onProgress({ phase: 3, step: 'generating_report' })

  const effectiveUntil = until || new Date()
  const reportSent = await generateAndSendBackfillReport(
    userId,
    result.phase1,
    p1.filteredSenders,
    since,
    effectiveUntil
  )
  result.report = { sent: reportSent }

  console.log(`[BulkIngest] Phase 3 complete: report ${reportSent ? 'sent' : 'FAILED'}`)
  onProgress({ phase: 3, step: 'complete', reportSent })

  // Phase 4: Enrich stored messages (classify + embed)
  // Runs AFTER the report so the user gets their backfill summary
  // even if enrichment times out on Vercel's maxDuration.
  const p4 = await phase4Enrich(userId, onProgress)
  result.enrichment = {
    enriched: p4.enriched,
    enrichmentFailed: p4.enrichmentFailed,
  }
  result.errors.push(...p4.errors)

  return result
}
