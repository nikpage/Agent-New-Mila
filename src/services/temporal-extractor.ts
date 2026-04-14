/**
 * Temporal extractor service.
 * Calls the LLM to find Czech temporal expressions, then executes the
 * generated DSL code to produce resolved ISO-8601 dates.
 *
 * This is a go/no-go experiment (Chunk 4). It is NOT yet wired into
 * ingestion.ts — that happens in Chunk 7.
 */

import { runAITask } from '@/lib/ai/runner'
import { executeDSLCode } from '@/lib/temporal/executor'
import { buildTemporalPrompt } from '@/lib/temporal/prompt'
import type { UserSettings } from '@/lib/supabase/types'

export interface TemporalExpression {
  original_text: string
  generated_code: string
  resolved_date: string | null  // ISO-8601, null if execution failed
  execution_error: string | null
  confidence: number
}

export interface TemporalResult {
  expressions: TemporalExpression[]
  needs_human_review: boolean  // true if any expression failed to execute
}

/**
 * Extract and resolve temporal expressions from a message.
 *
 * @param text             Cleaned message text (Czech)
 * @param messageTimestamp When the message was sent (used as DSL anchor)
 * @param _settings        Reserved for future language/locale config
 */
export async function extractTemporalExpressions(
  text: string,
  messageTimestamp: Date,
  _settings: UserSettings
): Promise<TemporalResult> {
  const prompt = buildTemporalPrompt(text, messageTimestamp.toISOString())

  let raw: string
  try {
    raw = await runAITask('temporal', prompt)
  } catch (err) {
    console.error('[Temporal] LLM call failed:', err)
    return { expressions: [], needs_human_review: false }
  }

  // Strip markdown fences if the model wrapped the output
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

  let parsed: Array<{ original_text: string; generated_code: string; confidence: number }>
  try {
    parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) throw new Error('expected array')
  } catch (err) {
    console.error('[Temporal] Failed to parse LLM response:', err, '\nRaw:', raw)
    return { expressions: [], needs_human_review: false }
  }

  const expressions: TemporalExpression[] = []
  let needsReview = false

  for (const item of parsed) {
    if (!item.original_text || !item.generated_code) continue

    let resolved_date: string | null = null
    let execution_error: string | null = null

    try {
      resolved_date = executeDSLCode(item.generated_code, messageTimestamp)
    } catch (err) {
      execution_error = err instanceof Error ? err.message : String(err)
      needsReview = true
      console.warn(`[Temporal] Execution failed for "${item.original_text}": ${execution_error}`)
    }

    expressions.push({
      original_text: item.original_text,
      generated_code: item.generated_code,
      resolved_date,
      execution_error,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
    })
  }

  return { expressions, needs_human_review: needsReview }
}
