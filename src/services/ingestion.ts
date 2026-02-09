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
import { findOrCreateCP } from '@/lib/db/counterparties'
import { createMessage, messageExists } from '@/lib/db/messages'
import { getUserById, upsertUser } from '@/lib/db/users'
import { generateMessageEmbedding } from '@/lib/embeddings/generate'
import { saveMessageEmbedding } from '@/lib/db/embeddings'
import { v4 as uuidv4 } from 'uuid'

/**
 * Senders that are always skipped — no message or CP is created for these.
 * These are automated / no-reply addresses that the AI classifier
 * occasionally lets through as actionable.
 */
const BLOCKED_SENDERS = [
  'no-reply@accounts.google.com',
  'noreply@google.com',
  'info@x.com',
  'calendar-notification@google.com',
]

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

      // Skip if sender is the user (outbound)
      if (senderEmail === userEmail) {
        continue
      }

      // Hard-block known automated / no-reply senders before classification
      if (BLOCKED_SENDERS.includes(senderEmail)) {
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

      // Find or create the counterparty
      // This will throw if we try to create a CP for the user themselves
      const cp = await findOrCreateCP(userId, senderEmail, senderName || undefined)

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
        if (senderEmail !== userEmail) {
          continue // Not from user, skip
        }

        // Get the first recipient as CP
        if (!email.to || email.to.length === 0) continue
        const recipientEmail = extractEmailAddress(email.to[0])
        const recipientName = extractName(email.to[0])

        // Skip if recipient is the user themselves
        if (recipientEmail === userEmail) continue

        // Skip blocked senders (in case user replies to automated)
        if (BLOCKED_SENDERS.includes(recipientEmail)) continue

        // Find or create CP for the recipient
        const cp = await findOrCreateCP(userId, recipientEmail, recipientName || undefined)

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
