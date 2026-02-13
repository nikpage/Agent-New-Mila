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
import { classifyEmail } from '@/lib/ai/gemini'
import { findOrCreateCP, isSameGmailAddress } from '@/lib/db/counterparties'
import { createMessage, messageExists } from '@/lib/db/messages'
import { getUserById, upsertUser } from '@/lib/db/users'
import { generateMessageEmbedding } from '@/lib/embeddings/generate'
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
function isBlockedSender(email: string): boolean {
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

  for (const email of emails) {
    try {
      // Check if already processed
      if (await messageExists(userId, email.id)) {
        continue
      }

      // Extract sender info
      const senderEmail = extractEmailAddress(email.from)
      const senderName = extractName(email.from)

      // Skip if sender is the user (outbound) — Gmail dot-insensitive
      if (isSameGmailAddress(senderEmail, userEmail)) {
        continue
      }

      // Hard-block known automated / no-reply senders before classification
      if (isBlockedSender(senderEmail)) {
        continue
      }

      // Classify the email
      const classification = await classifyEmail(
        email.subject,
        email.body,
        email.from
      )

      // Skip non-actionable emails entirely — no message stored without a CP
      if (!classification.isActionable) {
        continue
      }

      // Find or create the counterparty (null = user's own email, skip)
      const cp = await findOrCreateCP(userId, senderEmail, senderName || undefined)
      if (!cp) continue

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
        cleaned_text: email.body.slice(0, 5000),
        tag_primary: classification.category,
        tag_secondary: classification.priority,
        timestamp: email.date.toISOString(),
        occurred_at: email.date.toISOString(),
      })

      // Generate and save message embedding
      try {
        const embedding = await generateMessageEmbedding(email.body)
        await saveMessageEmbedding(messageId, embedding)
      } catch (error) {
        console.error(`Failed to generate embedding for message ${messageId}:`, error)
      }

      ingestedMessages.push({
        id: messageId,
        email,
        cpId: cp.id,
        isActionable: classification.isActionable,
        category: classification.category,
        priority: classification.priority,
      })
    } catch (error) {
      console.error(`Error processing email ${email.id}:`, error)
    }
  }

  return ingestedMessages
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

    for (const email of sentEmails) {
      try {
        // Skip if already processed
        if (await messageExists(userId, email.id)) {
          continue
        }

        // Sender is the user — extract recipients
        const senderEmail = extractEmailAddress(email.from)
        if (!isSameGmailAddress(senderEmail, userEmail)) {
          continue // Not from user, skip
        }

        // Get the first recipient as CP
        if (!email.to || email.to.length === 0) continue
        const recipientEmail = extractEmailAddress(email.to[0])
        const recipientName = extractName(email.to[0])

        // Skip if recipient is the user themselves
        if (isSameGmailAddress(recipientEmail, userEmail)) continue

        // Skip blocked senders (in case user replies to automated)
        if (isBlockedSender(recipientEmail)) continue

        // Find or create CP for the recipient (null = user's own email, skip)
        const cp = await findOrCreateCP(userId, recipientEmail, recipientName || undefined)
        if (!cp) continue

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
          cleaned_text: email.body.slice(0, 5000),
          tag_primary: 'outbound',
          tag_secondary: null,
          timestamp: email.date.toISOString(),
          occurred_at: email.date.toISOString(),
        })

        // Generate and save message embedding
        try {
          const embedding = await generateMessageEmbedding(email.body)
          await saveMessageEmbedding(messageId, embedding)
        } catch (error) {
          console.error(`Failed to generate embedding for outbound message ${messageId}:`, error)
        }

        ingested++
      } catch (error) {
        console.error(`Error processing outbound email ${email.id}:`, error)
      }
    }
  } catch (error) {
    console.error(`[Ingest] Failed to fetch sent emails for user ${userId}:`, error)
  }

  return ingested
}
