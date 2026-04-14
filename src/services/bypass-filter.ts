/**
 * Bypass Filter (Chunk 7a — Phase 1.2)
 *
 * Detects genuine emergencies BEFORE the normal pipeline runs.
 * One cheap LLM call per message. Fails open (non-emergency) on any failure.
 *
 * "Emergency" means something irreversible is happening within hours:
 *   - A hard deadline that will be missed TODAY
 *   - A counterparty threatening to walk away immediately
 *   - A legal/financial crisis requiring same-day response
 *
 * NOT an emergency: urgency scores, high-value deals, normal meeting requests.
 */

import { runAITask } from '@/lib/ai/runner'
import type { UserSettings } from '@/lib/supabase/types'

export interface BypassResult {
  isEmergency: boolean
  reason: string
}

const EMERGENCY_EXAMPLES = [
  'Counterparty says deal is off unless they hear back in 2 hours',
  'Bank financing approval expires today',
  'Contract signing deadline is this afternoon',
  'Client is walking to another agent right now',
].join('\n')

const NON_EMERGENCY_EXAMPLES = [
  'High-value deal that needs attention soon',
  'Client asking for a meeting next week',
  'Document to review by end of the week',
  'Follow-up on an offer from yesterday',
].join('\n')

/**
 * Check whether a message text represents a genuine emergency.
 *
 * @param text     Cleaned message text
 * @param channel  'email' | 'whatsapp' (WhatsApp emergencies are weighted higher)
 * @param settings User settings (for language context)
 */
export async function checkBypass(
  text: string,
  channel: string,
  settings: UserSettings
): Promise<BypassResult> {
  if (!text.trim()) {
    return { isEmergency: false, reason: 'empty message' }
  }

  const prompt = `You are screening messages for a real estate professional's assistant.

TASK: Determine if this message is a GENUINE EMERGENCY requiring immediate action TODAY (within hours).

EMERGENCY means:
- An irreversible deadline will be missed TODAY without immediate action
- A counterparty is walking away or cancelling RIGHT NOW
- A legal or financial event with same-day consequences

NOT an emergency (these are urgent but not emergencies):
- High-value deals
- Meeting requests
- Documents due within days
- Normal follow-ups

EXAMPLES of emergencies:
${EMERGENCY_EXAMPLES}

EXAMPLES that are NOT emergencies:
${NON_EMERGENCY_EXAMPLES}

MESSAGE (channel: ${channel}, language: ${settings.ai_language ?? 'Czech'}):
"""
${text.slice(0, 800)}
"""

Respond with ONLY valid JSON — no explanation, no markdown:
{"is_emergency": true/false, "reason": "one sentence"}`

  let raw: string
  try {
    raw = await runAITask('bypass', prompt)
  } catch (err) {
    console.warn(`[BypassFilter] LLM call failed, treating as non-emergency: ${err}`)
    return { isEmergency: false, reason: 'llm_unavailable' }
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { isEmergency: false, reason: 'parse_failed' }
  }

  let parsed: { is_emergency?: boolean; reason?: string }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return { isEmergency: false, reason: 'parse_failed' }
  }

  return {
    isEmergency: parsed.is_emergency === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  }
}
