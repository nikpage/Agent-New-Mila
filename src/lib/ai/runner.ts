/**
 * AI Task Runner with Fallback
 * Tries primary model, then fallback1, then fallback2 (if set).
 * On 429 / rate-limit errors, retries same model with exponential backoff
 * before falling through to the next model in the chain.
 *
 * Supports a one-time probe: call probeAIAvailability() at the start of a
 * long-running pipeline (bulk ingest, agent run). If Gemini is geo-blocked
 * or otherwise unavailable, all Gemini models are skipped for the rest of
 * the process lifetime — saving hundreds of wasted API calls.
 */

import { AI_TASK_MODELS, type AIStage } from '@/config/ai-models'
import { resolveProvider } from './providers'

const MAX_RETRIES = 3

/** When true, skip all gemini-* models in the chain. Set by probeAIAvailability(). */
let geminiDisabled = false

/** Check if Gemini is currently disabled (geo-block, auth failure, etc.). Used by embeddings. */
export function isGeminiDisabled(): boolean {
  return geminiDisabled
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('rate_limit')
}

/**
 * Probe whether Gemini is available. Call once at the start of a pipeline.
 * If Gemini responds, great. If it fails (geo-block, auth, etc.), all
 * subsequent runAITask calls skip Gemini models automatically.
 */
export async function probeAIAvailability(): Promise<void> {
  try {
    const provider = resolveProvider('gemini-2.5-flash-lite')
    await provider.generateContent('gemini-2.5-flash-lite', 'Reply with "ok"')
    geminiDisabled = false
    console.log('[AI] Probe: Gemini available')
  } catch (error) {
    geminiDisabled = true
    const msg = error instanceof Error ? error.message.slice(0, 120) : 'Unknown'
    console.warn(`[AI] Probe: Gemini unavailable (${msg}), using Claude for this run`)
  }
}

export async function runAITask(stage: AIStage, prompt: string): Promise<string> {
  const chain = AI_TASK_MODELS[stage]
  const allModels = [chain.primary, chain.fallback1, chain.fallback2]

  // Filter out nulls and skip gemini if probe found it unavailable
  const models = allModels.filter((m): m is string => {
    if (m === null) return false
    if (geminiDisabled && m.startsWith('gemini-')) return false
    return true
  })

  if (models.length === 0) {
    throw new Error(`[AI] No available models for stage '${stage}' (gemini disabled, no Claude fallback configured)`)
  }

  for (let i = 0; i < models.length; i++) {
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        const provider = resolveProvider(models[i])
        const result = await provider.generateContent(models[i], prompt)
        console.log(`[AI] ${stage} → ${models[i]}`)
        return result
      } catch (error) {
        if (isRateLimitError(error) && retry < MAX_RETRIES) {
          const delay = Math.pow(2, retry) * 1000 // 1s, 2s, 4s
          console.warn(`[AI] ${stage} rate-limited on ${models[i]}, retry ${retry + 1}/${MAX_RETRIES} in ${delay}ms`)
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
