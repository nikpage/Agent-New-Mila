/**
 * Provider Resolver
 * Routes a model name to the correct AI provider.
 */

import type { AIProvider } from './types'
import { geminiProvider } from './gemini'

export function resolveProvider(modelName: string): AIProvider {
  if (modelName.startsWith('gemini-')) return geminiProvider

  // Future providers:
  // if (modelName.startsWith('gpt-')) return openaiProvider
  // if (modelName.startsWith('claude-')) return anthropicProvider

  throw new Error(`Unknown AI provider for model: ${modelName}`)
}

export type { AIProvider }
