/**
 * Email Ingestion Service
 * Fetches emails from Gmail and processes them into the system
 */

import {
  fetchUnreadEmails,
  extractEmailAddress,
  extractName,
  type EmailMessage,
} from '@/lib/google/gmail'
import { classifyEmail } from '@/lib/ai/gemini'
import { findOrCreateCP } from '@/lib/db/counterparties'
import { createMessage, messageExists } from '@/lib/db/messages'
import { getUserById } from '@/lib/db/users'
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
 * Ingest emails for a user
 */
export async function ingestEmailsForUser(
  userId: string,
  maxEmails: number = 50
): Promise<IngestedMessage[]> {
  const user = await getUserById(userId)
  if (!user) {
    throw new Error(`User not found: ${userId}`)
  }

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
      if (senderEmail === user.email?.toLowerCase()) {
        continue
      }

      // Hard-block known automated / no-reply senders before classification
      if (BLOCKED_SENDERS.includes(senderEmail)) {
        console.log(`[Ingest] Blocked sender skipped: ${senderEmail} (${email.id})`)
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
        console.log(`[Ingest] Non-actionable email skipped: ${classification.category} from ${senderEmail} (${email.id})`)
        continue
      }

      // Find or create the counterparty
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
 * Ingest outbound emails (for tracking user responses)
 */
export async function ingestOutboundEmails(
  userId: string,
  since: Date
): Promise<number> {
  const user = await getUserById(userId)
  if (!user || !user.email) {
    return 0
  }

  // This would fetch sent emails and track them
  // For now, we rely on Gmail thread IDs to correlate responses
  return 0
}
