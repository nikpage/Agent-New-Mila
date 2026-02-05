import { GoogleGenerativeAI } from '@google/generative-ai'

let genAI: GoogleGenerativeAI | null = null

function getEmbeddingClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
    genAI = new GoogleGenerativeAI(apiKey)
  }
  return genAI
}

/**
 * Generate embedding for text
 * Model: text-embedding-004
 * Dimensions: 768
 * Purpose: semantic-search
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getEmbeddingClient()
  const model = client.getGenerativeModel({ model: 'text-embedding-004' })

  const result = await model.embedContent(text)
  return result.embedding.values
}

/**
 * Generate embedding for a message
 */
export async function generateMessageEmbedding(messageText: string): Promise<number[]> {
  return generateEmbedding(messageText)
}

/**
 * Generate embedding for a conversation
 */
export async function generateConversationEmbedding(messages: string[]): Promise<number[]> {
  const conversationText = messages.join('\n')
  return generateEmbedding(conversationText)
}
