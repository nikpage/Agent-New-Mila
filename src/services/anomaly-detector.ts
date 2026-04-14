/**
 * Anomaly Detector (Chunk 8b — Phase 4.1)
 *
 * Per-message "deal of the year" insurance.
 * Cheap LLM call that detects unusually high stakes or deal-killing risks
 * that wouldn't score high on normal business rules.
 *
 * If anomaly detected → write anomaly_boost to deals.anomaly_boost.
 * The scoring engine picks this up in the next batch run.
 */

import { runAITask } from '@/lib/ai/runner'
import type { UserSettings } from '@/lib/supabase/types'

export interface AnomalyResult {
  is_anomaly: boolean
  reason: string
}

export interface DealSummary {
  deal_id: string
  deal_title: string
  entity_map_snapshot: Record<string, string>
}

/**
 * Check whether a message + deal context represents an anomaly:
 * unusually high stakes, an irreversible deadline, or a deal-killing risk
 * that normal scoring would miss.
 *
 * Fails open (non-anomaly) on any LLM or parse error.
 */
export async function detectAnomaly(
  messageText: string,
  dealContext: DealSummary,
  settings: UserSettings
): Promise<AnomalyResult> {
  if (!messageText.trim()) {
    return { is_anomaly: false, reason: 'empty message' }
  }

  const entityLines = Object.entries(dealContext.entity_map_snapshot)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n') || '  (none)'

  const prompt = `You are a risk detector for a real estate professional's assistant.

TASK: Given this deal context and new message, is there an ANOMALY — something that represents unusually high stakes, an irreversible deadline, or a deal-killing risk that wouldn't score high on normal business rules?

DEAL: "${dealContext.deal_title}"
KNOWN FACTS:
${entityLines}

NEW MESSAGE (${settings.ai_language ?? 'Czech'}):
"""
${messageText.slice(0, 1000)}
"""

ANOMALY examples:
- Commission at risk (CP talking to another agent)
- Irreversible legal action within hours (bank revocation, contract rescission)
- Extraordinarily high value not yet captured in entity map
- Deal-stage regression (thought to be closed, but now re-opened)
- Counterparty health or force-majeure events

NOT anomalies:
- Normal urgency (reply needed, deadline in 2 days)
- Known facts already in entity map
- Routine follow-ups

Respond with ONLY valid JSON:
{"is_anomaly": true/false, "reason": "one sentence"}`

  let raw: string
  try {
    raw = await runAITask('anomaly', prompt)
  } catch (err) {
    console.warn(`[AnomalyDetector] LLM call failed, treating as non-anomaly: ${err}`)
    return { is_anomaly: false, reason: 'llm_unavailable' }
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { is_anomaly: false, reason: 'parse_failed' }
  }

  let parsed: { is_anomaly?: boolean; reason?: string }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return { is_anomaly: false, reason: 'parse_failed' }
  }

  return {
    is_anomaly: parsed.is_anomaly === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  }
}
