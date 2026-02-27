/**
 * AI Task Runner with Fallback
 * Tries primary model, then fallback1, then fallback2 (if set).
 * On 429 / rate-limit errors, retries same model with exponential backoff
 * before falling through to the next model in the chain.
 */

import { AI_TASK_MODELS, type AIStage } from '@/config/ai-models'
import { resolveProvider } from './providers'

const MAX_RETRIES = 3

let lastCallInfo: { stage: string; model: string } | null = null
export function getLastAICallInfo(): { stage: string; model: string } | null { return lastCallInfo }

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('503') || msg.includes('service unavailable')
}

export async function runAITask(stage: AIStage, prompt: string): Promise<string> {
  const chain = AI_TASK_MODELS[stage]
  const models = [chain.primary, chain.fallback1, chain.fallback2].filter((m): m is string => m !== null)
  const options = chain.temperature !== undefined ? { temperature: chain.temperature } : undefined

  for (let i = 0; i < models.length; i++) {
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        const provider = resolveProvider(models[i])
        const result = await provider.generateContent(models[i], prompt, options)
        lastCallInfo = { stage, model: models[i] }
        console.log(`[AI] ${stage} → ${models[i]}`)
        return result
      } catch (error) {
        if (isRetryableError(error) && retry < MAX_RETRIES) {
          const delay = Math.pow(2, retry) * 1000 // 1s, 2s, 4s
          console.warn(`[AI] ${stage} retrying ${models[i]} (${retry + 1}/${MAX_RETRIES}) in ${delay}ms`)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }

        const label = i === 0 ? 'primary' : `fallback${i}`
        console.error(`[AI] ${stage} failed on ${label} (${models[i]}):`, error)
        if (i === models.length - 1) {
          throw error
        }
        break // move to next model
      }
    }
  }

  throw new Error(`[AI] All models exhausted for stage '${stage}'`)
}
