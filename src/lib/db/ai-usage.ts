/**
 * AI Usage Log — per-stage per-run cost tracking.
 * One row per AI stage per agent run.
 */

import { getSupabaseAdmin } from '../supabase/client'

export interface AIUsageRow {
  user_id: string
  run_at: string          // ISO timestamp
  stage: string           // e.g. 'filter', 'triage', 'drafting'
  model: string           // e.g. 'gemini-2.5-flash-lite'
  calls: number
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

/**
 * Insert AI usage rows for a single agent run.
 * Non-blocking — caller should catch errors.
 */
export async function insertAIUsage(rows: AIUsageRow[]): Promise<void> {
  if (rows.length === 0) return
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('ai_usage_log').insert(rows)
  if (error) {
    console.warn(`[AIUsage] Failed to insert ${rows.length} rows: ${error.message}`)
  }
}
