/**
 * Embedding Generation
 * Uses Gemini embedding model (gemini-embedding-001, 768-dim, multilingual).
 * No fallback chain — embeddings are Gemini-only. When Gemini is unavailable
 * (geo-block, missing key), calls are skipped silently. The app works without
 * embeddings: threading falls back to Gmail thread ID matching.
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import { isGeminiDisabled } from '@/lib/ai/runner'

let genAI: GoogleGenerativeAI | null = null

function getEmbeddingClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
    genAI = new GoogleGenerativeAI(apiKey)
  }
  return genAI
}

export const embeddings = {
  model: 'models/gemini-embedding-001',
  dim: 768,
  purpose: 'semantic-search',
  language: 'multilingual',
}

// ─── Email Text Cleaning ────────────────────────────────────────────────────

/**
 * Strip email noise before embedding: quoted replies, forwarded headers,
 * signatures, legal disclaimers, tracking pixels, unsubscribe blocks.
 * Deterministic — no AI cost.
 */
export function cleanEmailText(text: string): string {
  let cleaned = text

  // Remove forwarded-message headers (multilingual)
  cleaned = cleaned.replace(/^-{2,}\s*(Forwarded message|Přeposlaná zpráva|Weitergeleitete Nachricht)\s*-{2,}[\s\S]*?^(Subject|Předmět|Betreff):.*$/mi, '')

  // Remove quoted reply blocks: lines starting with ">" (possibly nested)
  cleaned = cleaned.replace(/^(>{1,}\s?.*\n?)+/gm, '')

  // Remove "On <date> <person> wrote:" preamble lines (EN, CS, DE)
  cleaned = cleaned.replace(/^(On |Dne |Am ).+?(wrote|napsal|schrieb):?\s*$/gm, '')

  // Remove signatures: everything after a line that is exactly "-- " or "—"
  cleaned = cleaned.replace(/^(--|—)\s*\n[\s\S]*$/m, '')

  // Remove legal/confidentiality disclaimers (common in corporate email)
  cleaned = cleaned.replace(/^(This email|Tato zpráva|Diese E-Mail).{0,30}(confidential|důvěrná|vertraulich)[\s\S]{0,500}$/gim, '')

  // Remove unsubscribe/opt-out blocks
  cleaned = cleaned.replace(/^.{0,20}(unsubscribe|odhlásit|abmelden).*$/gim, '')

  // Remove tracking pixel / image tags
  cleaned = cleaned.replace(/<img[^>]*>/gi, '')

  // Collapse multiple blank lines into one (before sig check so position is accurate)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

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

  return cleaned.trim()
}

// ─── Embedding Functions ────────────────────────────────────────────────────

export async function generateEmbedding(text: string): Promise<number[]> {
  if (isGeminiDisabled()) {
    throw new Error('[Embeddings] Skipped — Gemini unavailable (geo-block or missing key)')
  }
  console.log(`[Embeddings] Generating embedding via ${embeddings.model}`)
  const client = getEmbeddingClient()
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
 * Cleans email noise (signatures, quoted replies) before embedding.
 */
export async function generateMessageEmbedding(
  messageText: string
): Promise<number[]> {
  const cleaned = cleanEmailText(messageText)
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
  const cleanedMessages = messages.map(m => cleanEmailText(m)).filter(m => m.length > 0)
  const conversationText = cleanedMessages.join('\n')
  return generateEmbedding(conversationText || messages.join('\n'))
}
