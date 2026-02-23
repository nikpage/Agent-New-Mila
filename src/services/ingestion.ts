/**
 * Email Ingestion Service
 * Fetches emails from Gmail and processes them into the system
 */

import {
  fetchUnreadEmails,
  fetchRecentEmails,
  extractEmailAddress,
  extractName,
  getUserEmail,
  type EmailMessage,
} from '@/lib/google/gmail'
import { classifyEmail, enrichMessage } from '@/lib/ai/gemini'
import { findOrCreateCP, isSameGmailAddress } from '@/lib/db/counterparties'
import { createMessage, messageExists, updateMessage } from '@/lib/db/messages'
import { getUserById, upsertUser } from '@/lib/db/users'
import { generateMessageEmbedding, cleanMessageText } from '@/lib/embeddings/generate'
import { saveMessageEmbedding } from '@/lib/db/embeddings'
import { v4 as uuidv4 } from 'uuid'

/**
 * Senders that are always skipped — no message or CP is created for these.
 * Hard-coded list checked BEFORE the AI classifier runs so we don't waste
 * tokens on obvious automated / no-reply / transactional mail.
 *
 * Rules:
 *  - Exact email matches go in BLOCKED_SENDERS.
 *  - Prefix patterns go in BLOCKED_SENDER_PREFIXES (matched against the local
 *    part before the @).
 *  - Domain patterns go in BLOCKED_SENDER_DOMAINS (matched against the domain
 *    part after the @).
 */
const BLOCKED_SENDERS = [
  // Google
  'no-reply@accounts.google.com',
  'noreply@google.com',
  'calendar-notification@google.com',
  'notifications@google.com',
  'drive-shares-dm-noreply@google.com',
  // X / Twitter
  'info@x.com',
  'verify@x.com',
  'noreply@x.com',
  // Supabase
  'noreply@supabase.io',
  'noreply@supabase.com',
  'noreply@mail.supabase.com',
  'noreply@notifications.supabase.com',
  // GitHub
  'noreply@github.com',
  'notifications@github.com',
  // Vercel
  'noreply@vercel.com',
  'ship@vercel.com',
  // Stripe
  'noreply@stripe.com',
  'receipts@stripe.com',
  // LinkedIn
  'messages-noreply@linkedin.com',
  'invitations@linkedin.com',
  // Common transactional
  'mailer-daemon@googlemail.com',
  'postmaster@googlemail.com',
]

/** Local-part prefixes that indicate automated mail (before the @). */
const BLOCKED_SENDER_PREFIXES = [
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'mailer-daemon',
  'postmaster',
  'notifications',
  'notification',
  'automated',
  'auto-confirm',
  'bounce',
]

/** Domains that only send automated / transactional mail. */
const BLOCKED_SENDER_DOMAINS = [
  'amazonses.com',
  'sendgrid.net',
  'mailgun.org',
  'mandrillapp.com',
  'postmarkapp.com',
  'email.shopify.com',
  'notify.bugsnag.com',
  'mailer.hetzner.com',
]

/** Returns true if the sender should be blocked before AI classification. */
export function isBlockedSender(email: string): boolean {
  const lower = email.toLowerCase()
  if (BLOCKED_SENDERS.includes(lower)) return true

  const atIndex = lower.indexOf('@')
  if (atIndex === -1) return false

  const local = lower.slice(0, atIndex)
  const domain = lower.slice(atIndex + 1)

  if (BLOCKED_SENDER_PREFIXES.some(p => local === p || local.startsWith(p + '+'))) return true
  if (BLOCKED_SENDER_DOMAINS.includes(domain)) return true

  return false
}

export interface IngestedMessage {
  id: string
  email: EmailMessage
  cpId: string
  isActionable: boolean
  category: string
  priority: string
}

/**
 * Helper: Ensure user email is known and normalized
 */
async function getNormalizedUserEmail(userId: string): Promise<string> {
  let user = await getUserById(userId)
  if (!user) throw new Error(`User not found: ${userId}`)

  // If email is missing in DB, fetch from Gmail and update DB
  if (!user.email) {
    try {
      const emailFromGmail = await getUserEmail(userId)
      if (emailFromGmail) {
        user = await upsertUser({
          ...user,
          email: emailFromGmail,
        })
      }
    } catch (error) {
      console.error(`[Ingest] Failed to fetch user email from Gmail:`, error)
    }
  }

  if (!user.email) {
    throw new Error(`User ${userId} has no email address configured`)
  }

  return user.email.toLowerCase()
}

/**
 * Ingest emails for a user
 */
export async function ingestEmailsForUser(
  userId: string,
  maxEmails: number = 50
): Promise<IngestedMessage[]> {
  const userEmail = await getNormalizedUserEmail(userId)

  // Fetch unread emails
  const emails = await fetchUnreadEmails(userId, maxEmails)
  const ingestedMessages: IngestedMessage[] = []

  // Process emails in parallel batches — the AI classifyEmail() call is the
  // bottleneck (~200-500ms each). Batching 5 at a time gives ~5x speedup
  // while staying within Gemini rate limits.
  const INGESTION_CONCURRENCY = 5

  for (let i = 0; i < emails.length; i += INGESTION_CONCURRENCY) {
    const chunk = emails.slice(i, i + INGESTION_CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(email => processOneInboundEmail(email, userId, userEmail))
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        ingestedMessages.push(result.value)
      } else if (result.status === 'rejected') {
        console.error('[Ingest] Parallel email processing failed:', result.reason)
      }
    }
  }

  return ingestedMessages
}

/**
 * Process a single inbound email: dedup check → block check → classify → store.
 * Extracted to enable parallel processing of independent emails.
 */
async function processOneInboundEmail(
  email: EmailMessage,
  userId: string,
  userEmail: string
): Promise<IngestedMessage | null> {
  // Check if already processed
  if (await messageExists(userId, email.id)) {
    return null
  }

  // Extract sender info
  const senderEmail = extractEmailAddress(email.from)
  const senderName = extractName(email.from)

  // Skip if sender is the user (outbound) — Gmail dot-insensitive
  if (isSameGmailAddress(senderEmail, userEmail)) {
    return null
  }

  // Hard-block known automated / no-reply senders before classification
  if (isBlockedSender(senderEmail)) {
    return null
  }

  // Classify the email
  const classification = await classifyEmail(
    email.subject,
    email.body,
    email.from
  )

  // Store non-actionable emails as a minimal record so we never re-classify them.
  // No CP is created — we just need messageExists() to return true next run.
  if (!classification.isActionable) {
    const skippedId = uuidv4()
    await createMessage({
      id: skippedId,
      user_id: userId,
      cp_id: null,
      external_id: email.id,
      external_thread_id: email.threadId,
      universal_message_id: email.id,
      direction: 'inbound',
      raw_text: '',
      cleaned_text: null,
      tag_primary: 'non_actionable',
      tag_secondary: classification.category || null,
      timestamp: email.date.toISOString(),
      occurred_at: email.date.toISOString(),
    })
    return null
  }

  // Find or create the counterparty (null = user's own email, skip)
  const cp = await findOrCreateCP(userId, senderEmail, senderName || undefined)
  if (!cp) return null

  // Create the message record
  const messageId = uuidv4()
  await createMessage({
    id: messageId,
    user_id: userId,
    cp_id: cp.id,
    external_id: email.id,
    external_thread_id: email.threadId,
    universal_message_id: email.id,
    direction: 'inbound',
    raw_text: email.body,
    cleaned_text: cleanMessageText(email.body, 'email').slice(0, 5000),
    tag_primary: classification.category,
    tag_secondary: classification.priority,
    timestamp: email.date.toISOString(),
    occurred_at: email.date.toISOString(),
  })

  // Enrich message: extract key info, save enriched text, embed it
  try {
    const cleanedText = cleanMessageText(email.body, 'email')
    const enrichedText = await enrichMessage(cleanedText, 'email', 'inbound')
    await updateMessage(messageId, { enriched_text: enrichedText })

    // Embed the enriched text (not the raw body)
    const embedding = await generateMessageEmbedding(enrichedText, 'email')
    await saveMessageEmbedding(messageId, embedding)
  } catch (error) {
    console.error(`Failed to enrich/embed message ${messageId}:`, error)
  }

  return {
    id: messageId,
    email,
    cpId: cp.id,
    isActionable: classification.isActionable,
    category: classification.category,
    priority: classification.priority,
  }
}

/**
 * Ingest outbound emails (for tracking user-initiated conversations)
 * Detects when user sends emails mentioning meetings/scheduling
 * so Mila can proactively check calendar and prepare slots.
 */
export async function ingestOutboundEmails(
  userId: string,
  since: Date
): Promise<number> {
  const userEmail = await getNormalizedUserEmail(userId)
  let ingested = 0

  try {
    // Fetch recently sent emails
    const sentEmails = await fetchRecentEmails(userId, {
      maxResults: 20,
      labelIds: ['SENT'],
      after: since,
    })

    // Process outbound emails in parallel batches
    const OUTBOUND_CONCURRENCY = 5

    for (let i = 0; i < sentEmails.length; i += OUTBOUND_CONCURRENCY) {
      const chunk = sentEmails.slice(i, i + OUTBOUND_CONCURRENCY)
      const results = await Promise.allSettled(
        chunk.map(email => processOneOutboundEmail(email, userId, userEmail))
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          ingested++
        } else if (result.status === 'rejected') {
          console.error('[Ingest] Parallel outbound processing failed:', result.reason)
        }
      }
    }
  } catch (error) {
    console.error(`[Ingest] Failed to fetch sent emails for user ${userId}:`, error)
  }

  return ingested
}

/**
 * Process a single outbound email: dedup check → store → embed.
 * Extracted to enable parallel processing.
 */
async function processOneOutboundEmail(
  email: EmailMessage,
  userId: string,
  userEmail: string
): Promise<boolean> {
  // Skip if already processed
  if (await messageExists(userId, email.id)) {
    return false
  }

  // Sender is the user — extract recipients
  const senderEmail = extractEmailAddress(email.from)
  if (!isSameGmailAddress(senderEmail, userEmail)) {
    return false // Not from user, skip
  }

  // Get the first recipient as CP
  if (!email.to || email.to.length === 0) return false
  const recipientEmail = extractEmailAddress(email.to[0])
  const recipientName = extractName(email.to[0])

  // Skip if recipient is the user themselves
  if (isSameGmailAddress(recipientEmail, userEmail)) return false

  // Skip blocked senders (in case user replies to automated)
  if (isBlockedSender(recipientEmail)) return false

  // Find or create CP for the recipient (null = user's own email, skip)
  const cp = await findOrCreateCP(userId, recipientEmail, recipientName || undefined)
  if (!cp) return false

  // Create the message record as outbound
  const messageId = uuidv4()
  await createMessage({
    id: messageId,
    user_id: userId,
    cp_id: cp.id,
    external_id: email.id,
    external_thread_id: email.threadId,
    universal_message_id: email.id,
    direction: 'outbound',
    raw_text: email.body,
    cleaned_text: cleanMessageText(email.body, 'email').slice(0, 5000),
    tag_primary: 'outbound',
    tag_secondary: null,
    timestamp: email.date.toISOString(),
    occurred_at: email.date.toISOString(),
  })

  // Enrich message: extract key info, save enriched text, embed it
  try {
    const cleanedText = cleanMessageText(email.body, 'email')
    const enrichedText = await enrichMessage(cleanedText, 'email', 'outbound')
    await updateMessage(messageId, { enriched_text: enrichedText })

    // Embed the enriched text (not the raw body)
    const embedding = await generateMessageEmbedding(enrichedText, 'email')
    await saveMessageEmbedding(messageId, embedding)
  } catch (error) {
    console.error(`Failed to enrich/embed outbound message ${messageId}:`, error)
  }

  return true
}
