/**
 * Embedding Generation
 * Uses Gemini embedding model (gemini-embedding-001, 768-dim, multilingual).
 * No fallback chain — embeddings are Gemini-only. When Gemini is unavailable
 * (geo-block, missing key), calls are skipped silently. The app works without
 * embeddings: threading falls back to Gmail thread ID matching.
 */

import { getNextClient } from '@/lib/ai/providers/gemini-keys'

export const embeddings = {
  model: 'models/gemini-embedding-001',
  dim: 768,
  purpose: 'semantic-search',
  language: 'multilingual',
}

// ─── Message Text Cleaning ──────────────────────────────────────────────────

export type MessageChannel = 'email' | 'email/gmail' | 'email/exchange' | 'whatsapp' | string

/**
 * Channel-aware message cleaning. Strips noise before enrichment/embedding.
 * Deterministic — no AI cost.
 *
 * - email / email/gmail: Full email cleaning (signatures, quoted replies, disclaimers, tracking)
 * - email/exchange: Gmail cleaning + Exchange-specific patterns (Outlook sigs, disclaimer banners, aka.ms links)
 * - whatsapp: Minimal — strip system messages only (WA messages are already clean)
 * - unknown: Universal cleaning only (collapse whitespace, strip tracking pixels)
 */
export function cleanMessageText(text: string, channel: MessageChannel = 'email'): string {
  if (channel === 'whatsapp') {
    return cleanWhatsAppText(text)
  }

  // Email cleaning (Gmail base)
  let cleaned = cleanEmailBase(text)

  // Exchange-specific additions
  if (channel === 'email/exchange') {
    cleaned = cleanExchangeText(cleaned)
  }

  return cleaned.trim()
}

/** Backward-compatible alias */
export function cleanEmailText(text: string): string {
  return cleanMessageText(text, 'email')
}

/**
 * Clean message text for enrichment — removes noise but KEEPS signatures.
 * Signatures contain addresses, company names, titles that enrichment needs.
 * Use this when passing text to enrichMessage(). Use cleanMessageText() for embeddings.
 */
export function cleanMessageTextForEnrichment(text: string, channel: MessageChannel = 'email'): string {
  if (channel === 'whatsapp') {
    return cleanWhatsAppText(text)
  }

  let cleaned = cleanEmailBaseKeepSignature(text)

  if (channel === 'email/exchange') {
    cleaned = cleanExchangeText(cleaned)
  }

  return cleaned.trim()
}

/** Core email cleaning — Gmail patterns (also base for Exchange) */
function cleanEmailBase(text: string): string {
  let cleaned = cleanEmailBaseKeepSignature(text)

  // Remove signatures: everything after a line that is exactly "-- " or "—"
  cleaned = cleaned.replace(/^(--|—)\s*\n[\s\S]*$/m, '')

  // Remove common email signatures: "S pozdravem", "Best regards", etc.
  // Only strip from the line onward if it appears in the second half of the
  // remaining text (after all other noise has been removed).
  const sigPatterns = /^(S pozdravem|Se srdečným pozdravem|Best regards?|Kind regards?|Regards|Sent from my|Odesláno z|S úctou|Děkuji a přeji|Mgr\.|Ing\.|PhDr\.|JUDr\.)[\s,]/im
  const sigMatch = cleaned.match(sigPatterns)
  if (sigMatch && sigMatch.index != null) {
    const position = sigMatch.index / cleaned.length
    if (position > 0.3) {
      cleaned = cleaned.slice(0, sigMatch.index)
    }
  }

  return cleaned
}

/**
 * Email cleaning that keeps signatures intact.
 * Used for enrichment — signatures contain addresses, names, titles, company info
 * that the AI needs to extract.
 */
function cleanEmailBaseKeepSignature(text: string): string {
  let cleaned = text

  // Remove forwarded-message headers (multilingual)
  cleaned = cleaned.replace(/^-{2,}\s*(Forwarded message|Přeposlaná zpráva|Weitergeleitete Nachricht)\s*-{2,}[\s\S]*?^(Subject|Předmět|Betreff):.*$/mi, '')

  // Remove quoted reply blocks: lines starting with ">" (possibly nested)
  cleaned = cleaned.replace(/^(>{1,}\s?.*\n?)+/gm, '')

  // Remove "On <date> <person> wrote:" preamble lines (EN, CS, DE)
  cleaned = cleaned.replace(/^(On |Dne |Am ).+?(wrote|napsal|schrieb):?\s*$/gm, '')

  // Remove legal/confidentiality disclaimers (common in corporate email)
  cleaned = cleaned.replace(/^(This email|Tato zpráva|Diese E-Mail).{0,30}(confidential|důvěrná|vertraulich)[\s\S]{0,500}$/gim, '')

  // Remove unsubscribe/opt-out blocks
  cleaned = cleaned.replace(/^.{0,20}(unsubscribe|odhlásit|abmelden).*$/gim, '')

  // Remove tracking pixel / image tags
  cleaned = cleaned.replace(/<img[^>]*>/gi, '')

  // Collapse multiple blank lines into one
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  return cleaned
}

/** Exchange/Outlook-specific noise on top of base email cleaning */
function cleanExchangeText(text: string): string {
  let cleaned = text

  // Remove "EXTERNAL EMAIL" / "CAUTION: External" banners
  cleaned = cleaned.replace(/^.{0,10}(EXTERNAL EMAIL|CAUTION:\s*External|POZOR:\s*Extern).*$/gim, '')

  // Remove Outlook-style "From: ... Sent: ... To: ... Subject: ..." quoted reply headers
  cleaned = cleaned.replace(/^From:\s+.+\nSent:\s+.+\nTo:\s+.+\n(Cc:\s+.+\n)?Subject:\s+.+$/gim, '')

  // Remove aka.ms links (Microsoft service URLs in signatures/disclaimers)
  cleaned = cleaned.replace(/https?:\/\/aka\.ms\/\S+/gi, '')

  // Remove Microsoft disclaimer blocks ("Microsoft respects your privacy...")
  cleaned = cleaned.replace(/^.{0,20}Microsoft respects your privacy[\s\S]{0,300}$/gim, '')

  // Remove "Get Outlook for" app promotion lines
  cleaned = cleaned.replace(/^Get Outlook for (iOS|Android|Windows|Mac).*$/gim, '')

  // Collapse multiple blank lines again after Exchange-specific removal
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  return cleaned
}

/** WhatsApp cleaning — minimal, messages are already clean */
function cleanWhatsAppText(text: string): string {
  let cleaned = text

  // Strip WhatsApp system messages
  cleaned = cleaned.replace(/^.{0,5}Messages and calls are end-to-end encrypted.*$/gim, '')
  cleaned = cleaned.replace(/^.{0,5}This message was deleted\.?$/gim, '')
  cleaned = cleaned.replace(/^.{0,5}You deleted this message\.?$/gim, '')

  // Strip forwarded labels
  cleaned = cleaned.replace(/^\[?Forwarded\]?\s*/gim, '')
  cleaned = cleaned.replace(/^\[?Přeposláno\]?\s*/gim, '')
  cleaned = cleaned.replace(/^\[?Přeposlané?\]?\s*/gim, '')

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  return cleaned.trim()
}

// ─── Embedding Functions ────────────────────────────────────────────────────

export async function generateEmbedding(text: string): Promise<number[]> {
  const { client, keyLabel, fingerprint } = getNextClient()
  console.log(`[Embeddings] Generating embedding via ${embeddings.model} (${keyLabel} ${fingerprint})`)
  const model = client.getGenerativeModel({
    model: embeddings.model,
  })
  const result = await model.embedContent({
    content: {
      role: "user",
      parts: [{ text }],
    },
    outputDimensionality: embeddings.dim,
  } as any)
  return result.embedding.values
}

/**
 * Generate embedding for a single message.
 * When skipCleaning is true (e.g. for enriched text), embeds the text as-is.
 * Otherwise cleans channel-specific noise before embedding.
 */
export async function generateMessageEmbedding(
  messageText: string,
  channel: MessageChannel = 'email',
  skipCleaning: boolean = false
): Promise<number[]> {
  if (skipCleaning) {
    return generateEmbedding(messageText)
  }
  const cleaned = cleanMessageText(messageText, channel)
  return generateEmbedding(cleaned || messageText)
}

/**
 * Generate embedding for a conversation.
 * Prefers summary text (distilled semantic signal) over raw messages.
 * Falls back to cleaned message text if no summary is available.
 */
export async function generateConversationEmbedding(
  messages: string[],
  summaryText?: string
): Promise<number[]> {
  if (summaryText && summaryText.length > 20) {
    return generateEmbedding(summaryText)
  }
  // Fallback: clean each message and concatenate
  const cleanedMessages = messages.map(m => cleanMessageText(m)).filter(m => m.length > 0)
  const conversationText = cleanedMessages.join('\n')
  return generateEmbedding(conversationText || messages.join('\n'))
}
