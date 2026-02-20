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

export async function generateMessageEmbedding(
  messageText: string
): Promise<number[]> {
  return generateEmbedding(messageText)
}

export async function generateConversationEmbedding(
  messages: string[]
): Promise<number[]> {
  const conversationText = messages.join('\n')
  return generateEmbedding(conversationText)
}
