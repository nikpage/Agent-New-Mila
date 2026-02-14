/**
 * AI Task Runner with Fallback
 * Tries primary model, then fallback1, then fallback2.
 */

import { AI_TASK_MODELS, type AIStage } from '@/config/ai-models'
import { resolveProvider } from './providers'

export async function runAITask(stage: AIStage, prompt: string): Promise<string> {
  const chain = AI_TASK_MODELS[stage]
  const models = [chain.primary, chain.fallback1, chain.fallback2]

  for (let i = 0; i < models.length; i++) {
    try {
      const provider = resolveProvider(models[i])
      const result = await provider.generateContent(models[i], prompt)
      if (i > 0) {
        console.log(`[AI] Stage '${stage}' succeeded on fallback${i} (${models[i]})`)
      }
      return result
    } catch (error) {
      const label = i === 0 ? 'primary' : `fallback${i}`
      console.error(`[AI] Stage '${stage}' failed on ${label} (${models[i]}):`, error)
      if (i === models.length - 1) {
        throw error
      }
    }
  }

  throw new Error(`[AI] All models exhausted for stage '${stage}'`)
}
