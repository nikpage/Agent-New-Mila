/**
 * Fact & Belief Extractor (Chunk 5)
 *
 * Replaces enrichMessage() + extractMessageFacts() with a single unified call
 * per deal message batch. Outputs hard facts (prices, addresses, deadlines,
 * commitments) and soft observations (tone, momentum, relationship signals)
 * with scratchpad-first reasoning for auditability.
 *
 * NOT yet wired into ingestion.ts — that happens in Chunk 7.
 */

import { runAITask } from '@/lib/ai/runner'
import type { TemporalResult } from './temporal-extractor'
import type { UserSettings } from '@/lib/supabase/types'

// ─── Input types ─────────────────────────────────────────────────────────────

export interface DealMessage {
  id: string
  /** FK to messages.id — null for call logs / voice notes that have no messages row */
  messageId?: string | null
  direction: 'in' | 'out' | 'internal'
  content: string
  occurred_at: string   // ISO-8601
  channel: 'email' | 'whatsapp' | 'call_log' | 'voice_note'
  cp_name?: string
}

export interface DealContext {
  deal_id: string
  deal_title: string
  deal_type: string | null
  current_state?: string
  entity_map_snapshot?: Array<{ type: string; key: string; value: string }>
}

// ─── Output types ─────────────────────────────────────────────────────────────

export type HardFactType =
  | 'price'
  | 'address'
  | 'deadline'
  | 'document_state'
  | 'commitment'
  | 'contact_info'
  | 'meeting_venue'
  | 'deal_stage'

export interface HardFact {
  type: HardFactType
  key: string             // e.g. "asking_price", "notary_address", "financing_deadline"
  value: string           // the fact value as a string
  source_message_id: string | null  // FK to messages.id — null for timeline entries without a messages row
  confidence: number      // 0.0–1.0
}

export interface SoftObservation {
  topic: string           // e.g. "buyer_urgency", "seller_flexibility", "deal_momentum"
  content: string         // the observation
  confidence: number
  source_message_id: string | null  // FK to messages.id — null for timeline entries without a messages row
}

export interface ExtractionOutput {
  scratchpad: string      // LLM reasoning — stored for audit, not shown to user
  hard_facts: HardFact[]
  soft_observations: SoftObservation[]
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildExtractionPrompt(
  messages: DealMessage[],
  temporalResult: TemporalResult,
  dealContext: DealContext,
  settings: UserSettings,
  gaps?: string[]
): string {
  const lang = settings.ai_language || 'Czech'
  const businessContext = `BUSINESS CONTEXT: ${settings.client_company} — ${settings.business_specialization}. Market: ${settings.business_market}.`

  // Format messages with 0-based indices so the LLM can reference them
  const formattedMessages = messages.map((m, i) => {
    const who = m.direction === 'out' ? 'vy' : (m.cp_name || 'protistrana')
    const date = m.occurred_at.slice(0, 10)
    return `[${i}] ${date} | ${m.direction} | ${who} (${m.channel}):\n${m.content.slice(0, 2000)}`
  }).join('\n\n')

  // Resolved timestamps for context
  const temporalBlock = temporalResult.expressions.length > 0
    ? `\nRESOLVED TIMESTAMPS:\n${temporalResult.expressions
        .filter(e => e.resolved_date)
        .map(e => `  "${e.original_text}" → ${e.resolved_date}`)
        .join('\n')}`
    : ''

  // Entity map snapshot (what we already know)
  const entityBlock = dealContext.entity_map_snapshot?.length
    ? `\nKNOWN FACTS (already in entity map — only output if you have NEW or UPDATED information):\n${dealContext.entity_map_snapshot.map(e => `  ${e.type}.${e.key} = ${e.value}`).join('\n')}`
    : ''

  // Gap instructions from the critic (re-run scenario)
  const gapBlock = gaps?.length
    ? `\nPREVIOUS EXTRACTION WAS INCOMPLETE. These gaps were identified — make sure to capture them:\n${gaps.map(g => `  - ${g}`).join('\n')}`
    : ''

  const currentStateBlock = dealContext.current_state
    ? `\nDEAL STATE: ${dealContext.current_state}`
    : ''

  return `${businessContext}
Deal: "${dealContext.deal_title}" (${dealContext.deal_type || 'type unknown'})
${currentStateBlock}${entityBlock}${temporalBlock}${gapBlock}

MESSAGES (0-indexed):
${formattedMessages}

─────────────────────────────────────────────────
TASK: Extract hard facts and soft observations from these messages.

First, write a SCRATCHPAD section where you think through what is present. Then output structured JSON.

HARD FACTS — verifiable information that can be stored as a key-value pair:
  Types and example keys:
  - price: "asking_price", "offer_price", "monthly_rent", "deposit"
  - address: "property_address", "notary_address", "meeting_venue_address"
  - deadline: "offer_deadline", "move_in_date", "contract_signing_date", "financing_approval_date"
  - document_state: "contract_status", "inspection_report_status", "financing_approval"
  - commitment: "seller_will_do", "buyer_will_do", "cp_commitment"
  - contact_info: "cp_phone", "cp_email", "lawyer_contact"
  - meeting_venue: "viewing_location", "signing_location"
  - deal_stage: "current_stage" (e.g. "initial_contact", "offer_made", "under_contract", "closing")

  Rules:
  - Only extract what is EXPLICITLY stated. No inference.
  - Key must be a snake_case identifier unique within type+deal.
  - Value must be a plain string — price includes currency, date includes year.
  - Use source_index (0-based) to reference which message it came from.

SOFT OBSERVATIONS — qualitative signals about the deal or relationship:
  Example topics: "buyer_urgency", "seller_flexibility", "deal_momentum",
  "cp_communication_style", "negotiation_posture", "risk_signal", "positive_signal"

  Rules:
  - Only capture observations meaningful for future action planning.
  - One observation per distinct signal — do not double-count.

OUTPUT FORMAT (scratchpad first, then JSON):

SCRATCHPAD:
[Think through what hard facts and soft observations are present. Note any ambiguities.]

JSON:
{
  "hard_facts": [
    {
      "type": "price",
      "key": "asking_price",
      "value": "4 500 000 Kč",
      "source_index": 0,
      "confidence": 0.95
    }
  ],
  "soft_observations": [
    {
      "topic": "buyer_urgency",
      "content": "Buyer mentioned moving deadline — time pressure is real",
      "confidence": 0.8,
      "source_index": 0
    }
  ]
}

CRITICAL: All text values (value, content) must be in ${lang}. Do not output English text values.`
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseExtractionResponse(
  raw: string,
  messages: DealMessage[]
): ExtractionOutput {
  // Extract scratchpad (text before "JSON:")
  const scratchpadMatch = raw.match(/SCRATCHPAD:\s*([\s\S]*?)(?=\nJSON:|$)/i)
  const scratchpad = scratchpadMatch ? scratchpadMatch[1].trim() : ''

  // Extract JSON block
  const jsonMatch = raw.match(/JSON:\s*(\{[\s\S]*\})/i) || raw.match(/(\{[\s\S]*\})/)
  if (!jsonMatch) {
    return { scratchpad, hard_facts: [], soft_observations: [] }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[1])
  } catch {
    return { scratchpad, hard_facts: [], soft_observations: [] }
  }

  // Map source_index → message id
  const hard_facts: HardFact[] = []
  const rawFacts = Array.isArray(parsed.hard_facts) ? parsed.hard_facts : []
  for (const f of rawFacts as Array<Record<string, unknown>>) {
    const idx = typeof f.source_index === 'number' ? f.source_index : 0
    const msg = messages[idx]
    if (!msg || typeof f.type !== 'string' || typeof f.key !== 'string' || typeof f.value !== 'string') continue
    hard_facts.push({
      type: f.type as HardFactType,
      key: f.key,
      value: f.value,
      source_message_id: msg.messageId ?? null,
      confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.8,
    })
  }

  const soft_observations: SoftObservation[] = []
  const rawObs = Array.isArray(parsed.soft_observations) ? parsed.soft_observations : []
  for (const o of rawObs as Array<Record<string, unknown>>) {
    const idx = typeof o.source_index === 'number' ? o.source_index : 0
    const msg = messages[idx]
    if (!msg || typeof o.topic !== 'string' || typeof o.content !== 'string') continue
    soft_observations.push({
      topic: o.topic,
      content: o.content,
      confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.7,
      source_message_id: msg.messageId ?? null,
    })
  }

  return { scratchpad, hard_facts, soft_observations }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract hard facts and soft observations from a batch of deal messages.
 * Called once per deal processing cycle (not per message).
 *
 * @param dealMessages    All new messages since last processing cycle
 * @param temporalResult  Resolved timestamps from temporal extractor
 * @param dealContext     Deal title, type, current state, known entity map
 * @param settings        User settings for language + business context
 * @param gaps            Optional gap list from reconstruction critic (re-run only)
 */
export async function extractFactsAndBeliefs(
  dealMessages: DealMessage[],
  temporalResult: TemporalResult,
  dealContext: DealContext,
  settings: UserSettings,
  gaps?: string[]
): Promise<ExtractionOutput> {
  if (dealMessages.length === 0) {
    return { scratchpad: '', hard_facts: [], soft_observations: [] }
  }

  const prompt = buildExtractionPrompt(dealMessages, temporalResult, dealContext, settings, gaps)

  let raw: string
  try {
    raw = await runAITask('extraction', prompt)
  } catch (err) {
    console.error('[FactExtractor] LLM call failed:', err)
    return { scratchpad: '', hard_facts: [], soft_observations: [] }
  }

  return parseExtractionResponse(raw, dealMessages)
}
