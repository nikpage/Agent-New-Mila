/**
 * Anthropic AI Provider
 * Wraps @anthropic-ai/sdk behind the AIProvider interface.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, AIGenerateOptions } from './types'

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
    client = new Anthropic({ apiKey })
    console.log('[Anthropic] Initialized')
  }
  return client
}

export const anthropicProvider: AIProvider = {
  async generateContent(model: string, prompt: string, options?: AIGenerateOptions): Promise<string> {
    const c = getClient()
    const message = await c.messages.create({
      model,
      max_tokens: 4096,
      temperature: options?.temperature ?? undefined,
      messages: [{ role: 'user', content: prompt }],
    })

    const block = message.content[0]
    if (block.type !== 'text') {
      throw new Error(`Unexpected response type: ${block.type}`)
    }
    return block.text
  },
}
