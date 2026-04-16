/**
 * AI Usage Log — per-stage per-run cost tracking.
 * One row per AI stage per agent run.
 */

import { getSupabaseAdmin } from '../supabase/client'

export interface AIUsageRow {
  user_id: string
  run_id: string            // UUID grouping all stages in one pipeline run
  run_at: string            // ISO timestamp
  stage: string             // e.g. 'filter', 'triage', 'drafting'
  model: string             // e.g. 'gemini-2.5-flash-lite'
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

/**
 * Get usage for a date range, aggregated per user per model.
 */
export async function getUsageByUserAndModel(
  since: string,
  until: string
): Promise<{ user_id: string; model: string; total_calls: number; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('ai_usage_log')
    .select('user_id, model, calls, input_tokens, output_tokens, cost_usd')
    .gte('run_at', since)
    .lt('run_at', until)

  if (error) {
    console.warn(`[AIUsage] Failed to query usage: ${error.message}`)
    return []
  }

  // Aggregate in JS (Supabase doesn't support GROUP BY in the REST API)
  const map = new Map<string, { user_id: string; model: string; total_calls: number; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }>()
  for (const r of data ?? []) {
    const key = `${r.user_id}:${r.model}`
    const entry = map.get(key)
    if (entry) {
      entry.total_calls += r.calls
      entry.total_input_tokens += r.input_tokens
      entry.total_output_tokens += r.output_tokens
      entry.total_cost_usd += r.cost_usd
    } else {
      map.set(key, {
        user_id: r.user_id,
        model: r.model,
        total_calls: r.calls,
        total_input_tokens: r.input_tokens,
        total_output_tokens: r.output_tokens,
        total_cost_usd: r.cost_usd,
      })
    }
  }

  return Array.from(map.values())
}

/**
 * Get cumulative all-time usage, aggregated per model.
 */
export async function getCumulativeUsage(): Promise<{ model: string; total_calls: number; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('ai_usage_log')
    .select('model, calls, input_tokens, output_tokens, cost_usd')

  if (error) {
    console.warn(`[AIUsage] Failed to query cumulative usage: ${error.message}`)
    return []
  }

  const map = new Map<string, { model: string; total_calls: number; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }>()
  for (const r of data ?? []) {
    const entry = map.get(r.model)
    if (entry) {
      entry.total_calls += r.calls
      entry.total_input_tokens += r.input_tokens
      entry.total_output_tokens += r.output_tokens
      entry.total_cost_usd += r.cost_usd
    } else {
      map.set(r.model, {
        model: r.model,
        total_calls: r.calls,
        total_input_tokens: r.input_tokens,
        total_output_tokens: r.output_tokens,
        total_cost_usd: r.cost_usd,
      })
    }
  }

  return Array.from(map.values())
}
