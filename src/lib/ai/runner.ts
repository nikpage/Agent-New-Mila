/**
 * AI Task Runner with Fallback
 * Tries primary model, then fallback1, then fallback2 (if set).
 * On 429 / rate-limit errors, retries same model with exponential backoff
 * before falling through to the next model in the chain.
 *
 * Tracks token usage per stage/model for cost estimation.
 */

import { AI_TASK_MODELS, type AIStage } from '@/config/ai-models'
import { resolveProvider } from './providers'
import { getLastFingerprint } from './providers/gemini'

const MAX_RETRIES = 3

let lastCallInfo: { stage: string; model: string } | null = null
export function getLastAICallInfo(): { stage: string; model: string } | null { return lastCallInfo }

// ─── Token usage tracking ───────────────────────────────────────────────────

export interface AIStageUsage {
  stage: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUSD: number
}

/** Per-million-token pricing (USD). Update when providers change pricing. */
const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Gemini — https://ai.google.dev/pricing
  'gemini-2.5-flash':        { inputPerM: 0.15,  outputPerM: 0.60 },
  'gemini-2.5-flash-lite':   { inputPerM: 0.075, outputPerM: 0.30 },
  // Anthropic — https://docs.anthropic.com/en/docs/about-claude/models
  'claude-haiku-4-5-20251001': { inputPerM: 0.80,  outputPerM: 4.00 },
  'claude-sonnet-4-6':       { inputPerM: 3.00,  outputPerM: 15.00 },
  'claude-opus-4-6':         { inputPerM: 15.00, outputPerM: 75.00 },
}

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  return (inputTokens / 1_000_000) * pricing.inputPerM + (outputTokens / 1_000_000) * pricing.outputPerM
}

const usageMap = new Map<string, AIStageUsage>()

function trackUsage(stage: string, model: string, inputTokens: number, outputTokens: number): void {
  const key = `${stage}:${model}`
  const cost = calcCost(model, inputTokens, outputTokens)
  const entry = usageMap.get(key)
  if (entry) {
    entry.calls++
    entry.inputTokens += inputTokens
    entry.outputTokens += outputTokens
    entry.costUSD += cost
  } else {
    usageMap.set(key, { stage, model, calls: 1, inputTokens, outputTokens, costUSD: cost })
  }
}

/** Get accumulated usage per stage/model since last reset. */
export function getAIUsage(): AIStageUsage[] {
  return Array.from(usageMap.values())
}

/** Get usage summary with cost breakdown. */
export function getAIUsageSummary(): {
  stages: AIStageUsage[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCalls: number
  totalCostUSD: number
} {
  const stages = getAIUsage()
  return {
    stages,
    totalInputTokens: stages.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: stages.reduce((sum, s) => sum + s.outputTokens, 0),
    totalCalls: stages.reduce((sum, s) => sum + s.calls, 0),
    totalCostUSD: stages.reduce((sum, s) => sum + s.costUSD, 0),
  }
}

/** Reset accumulated usage. Call at start of each pipeline run. */
export function resetAIUsage(): void {
  usageMap.clear()
}

// ─── Runner ─────────────────────────────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('503') || msg.includes('service unavailable')
}

export async function runAITask(stage: AIStage, prompt: string): Promise<string> {
  const chain = AI_TASK_MODELS[stage]
  const models = [chain.primary, chain.fallback1, chain.fallback2].filter((m): m is string => m !== null)
  const options: { temperature?: number; thinkingBudget?: number } = {}
  if (chain.temperature !== undefined) options.temperature = chain.temperature
  if (chain.thinkingBudget) options.thinkingBudget = chain.thinkingBudget

  for (let i = 0; i < models.length; i++) {
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        const provider = resolveProvider(models[i])
        const result = await provider.generateContent(models[i], prompt, options)
        lastCallInfo = { stage, model: models[i] }
        const fp = models[i].startsWith('gemini-') ? getLastFingerprint() : null
        const tokIn = result.usage?.inputTokens ?? 0
        const tokOut = result.usage?.outputTokens ?? 0
        const cost = calcCost(models[i], tokIn, tokOut)
        trackUsage(stage, models[i], tokIn, tokOut)
        console.log(`[AI] ${stage} → ${models[i]} (${tokIn}→${tokOut} tok, $${cost.toFixed(6)})${fp ? `\n  ${fp}` : ''}`)
        return result.text
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
