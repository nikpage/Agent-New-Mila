/**
 * WhatsApp Integration Types
 *
 * Types shared between the WA daemon (scripts/whatsapp-daemon.ts)
 * and the Next.js application.
 */

/** A message received from WhatsApp Web */
export interface WAIncomingMessage {
  /** WA message ID (e.g., "true_420777123456@c.us_3EB0...") */
  id: string
  /** Sender phone number with country code (e.g., "+420777123456") */
  from: string
  /** Recipient phone number (the client's number) */
  to: string
  /** Message body text */
  body: string
  /** When the message was sent */
  timestamp: Date
  /** Whether this is from a group chat */
  isGroup: boolean
  /** Group name if isGroup */
  groupName?: string
  /** Whether the message has media (photos, docs) */
  hasMedia: boolean
  /** WA display name of the sender (push name) */
  senderName?: string
}

/** Request to send a WhatsApp message via the daemon */
export interface WASendRequest {
  /** User ID — routes to the correct Baileys session */
  userId: string
  /** Recipient phone number with country code */
  to: string
  /** Message body text */
  body: string
  /** Optional: reply to a specific message ID */
  replyToMessageId?: string
}

/** Response from the daemon after attempting to send */
export interface WASendResponse {
  success: boolean
  messageId?: string
  error?: string
}

/** WhatsApp daemon connection status */
export interface WAConnectionStatus {
  /** Whether WA Web is connected and authenticated */
  connected: boolean
  /** Base64 QR code for pairing (only when not connected) */
  qrCode?: string
  /** The connected phone number */
  phone?: string
  /** Last time a message was received */
  lastMessageAt?: string
  /** Error message if something is wrong */
  error?: string
}

/**
 * Normalize a phone number for consistent matching.
 * Strips spaces, dashes, parens. Ensures + prefix.
 */
export function normalizePhoneNumber(phone: string): string {
  // Strip everything except digits and +
  let cleaned = phone.replace(/[^\d+]/g, '')
  // Ensure + prefix
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned
  }
  return cleaned
}

/**
 * Extract a phone-based "thread ID" for conversation grouping.
 * All WA messages from the same phone number share a thread.
 */
export function phoneToThreadId(phone: string): string {
  return `wa:${normalizePhoneNumber(phone)}`
}
