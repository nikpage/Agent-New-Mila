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

    const useThinking = options?.thinkingBudget && options.thinkingBudget > 0

    // When thinking is enabled, temperature must be 1 and max_tokens must cover thinking + response
    const message = await c.messages.create({
      model,
      max_tokens: useThinking ? options.thinkingBudget! + 4096 : 4096,
      ...(useThinking
        ? { thinking: { type: 'enabled' as const, budget_tokens: options.thinkingBudget! } }
        : {}),
      temperature: useThinking ? 1 : (options?.temperature ?? undefined),
      messages: [{ role: 'user', content: prompt }],
    })

    // With thinking enabled, response contains thinking blocks + text blocks
    for (const block of message.content) {
      if (block.type === 'text') {
        return block.text
      }
    }

    throw new Error(`No text block in response (got: ${message.content.map(b => b.type).join(', ')})`)
  },
}
