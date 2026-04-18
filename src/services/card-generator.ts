/**
 * Card Generator (Chunk 9a — Phase 3.3)
 *
 * Takes ranked ScoredTask[] from the scoring engine and produces ActionCard[]
 * ready for insertion into action_proposals.
 *
 * One LLM call per card (drafting stage — claude-sonnet primary).
 * Pulls current beliefs for tone tailoring.
 * Adds {{ placeholder }} for info the system can't answer.
 *
 * Fails open: LLM errors return a card with safe-default text.
 */

import { v4 as uuidv4 } from 'uuid'
import { runAITask } from '@/lib/ai/runner'
import { getCurrentBeliefs } from '@/lib/db/journal'
import { createAction } from '@/lib/db/actions'
import { getParticipants } from '@/lib/db/conversations'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import type { UserSettings, ActionProposal } from '@/lib/supabase/types'
import type { ScoredTask, ScoreBreakdown } from './scoring-engine'
import type { WalkerTaskType } from './graph-walker'

// ─── Output type ──────────────────────────────────────────────────────────────

export interface ActionCard {
  // Identity (from ScoredTask)
  nodeId: string
  dealId: string
  taskType: WalkerTaskType
  score: number
  scoreBreakdown: ScoreBreakdown
  cpId: string | null
  entityMapSnapshot: Record<string, string>
  beliefSnapshot: string[]

  // Venue/time — extracted from entity map for SCHEDULE cards
  meetingVenue: string | null
  proposedTime: string | null
  // Weight (immovability) — determined by LLM from deal context
  weight: number | null

  // Generated card fields
  card_type: 'REPLY' | 'SCHEDULE' | 'TODO'
  intent_cs: string
  rationale_cs: string
  draft_skeleton: string | null   // REPLY only — skeleton for generateFinalDraft()
  placeholders: string[]          // {{ placeholder }} items the system couldn't fill
  urgency: number                 // derived from taskType (same as scoring-engine)
}

// ─── Card type derivation ─────────────────────────────────────────────────────

/** Deterministic fallback card type — used when LLM fails or for task types with obvious mapping. */
export function deriveCardType(taskType: WalkerTaskType): 'REPLY' | 'SCHEDULE' | 'TODO' {
  if (taskType === 'inbound_reply' || taskType === 'lead_cooling' || taskType === 'lead_cold' || taskType === 'lead_dead') {
    return 'REPLY'
  }
  if (taskType === 'calendar_conflict') {
    return 'SCHEDULE'
  }
  return 'TODO'
}

// ─── Urgency mapping (mirrors scoring-engine) ─────────────────────────────────

function deriveUrgency(task: ScoredTask, hoursUntilDue: number | null): number {
  switch (task.taskType) {
    case 'overdue':          return 10
    case 'due_soon':
      return (hoursUntilDue !== null && hoursUntilDue < 4) ? 9 : 8
    case 'inbound_reply':
      // Use concrete time-to-meeting if enrichment gave us one; else fall back to signal.
      if (hoursUntilDue !== null) {
        if (hoursUntilDue < 4) return 10
        if (hoursUntilDue < 24) return 9
        if (hoursUntilDue < 48) return 8
        if (hoursUntilDue < 72) return 7
        return task.enrichmentSignal === 'HARD DEADLINE' ? 7 : 6
      }
      return task.enrichmentSignal === 'HARD DEADLINE' ? 8 : 7
    case 'blocking':         return 7
    case 'lead_dead':        return 7
    case 'calendar_conflict': return 6
    case 'lead_cold':        return 5
    case 'lead_cooling':     return 3
    case 'has_slack':        return 2
    default:                 return 1
  }
}

// ─── Fallback text (fail-open) ────────────────────────────────────────────────

function defaultIntentCs(taskType: WalkerTaskType): string {
  switch (taskType) {
    case 'inbound_reply': return 'Odpovědět na novou zprávu od {{ jméno_protistrany }}.'
    case 'lead_cooling': return 'Navázat kontakt — klient neodpovídal přes {{ počet_dní }} dní.'
    case 'lead_cold':    return 'Urgentní follow-up — klient je studený, kontaktujte ho co nejdříve.'
    case 'lead_dead':    return 'Poslední pokus o kontakt — deal je téměř ztracen.'
    case 'calendar_conflict': return 'Vyřešit kolizi v kalendáři — {{ čas_schůzky }}.'
    case 'overdue':      return 'Urgentní: termín byl překročen — {{ název_úkolu }}.'
    case 'due_soon':     return 'Deadline se blíží — dokončit {{ název_úkolu }}.'
    case 'blocking':     return 'Odblokovat deal — čeká na {{ název_úkolu }}.'
    case 'has_slack':    return 'Pokročit v dealu — termín {{ název_úkolu }} je za {{ dny_do_termínu }}.'
    default:             return 'Akce vyžaduje pozornost.'
  }
}

function defaultRationaleCs(taskType: WalkerTaskType): string {
  switch (taskType) {
    case 'inbound_reply': return 'Přišla nová zpráva vyžadující odpověď.'
    case 'lead_cooling': return 'Klient neprojevil aktivitu v posledních dnech. Vhodný čas pro lehký follow-up.'
    case 'lead_cold':    return 'Klient je neaktivní. Bez kontaktu hrozí ztráta obchodu.'
    case 'lead_dead':    return 'Klient dlouhodobě nereaguje. Jde o poslední šanci zachránit deal.'
    case 'calendar_conflict': return 'Dvě schůzky se překrývají. Je nutné je přeplánovat.'
    case 'overdue':      return 'Milník byl překročen. Zpoždění může blokovat další kroky v dealu.'
    case 'due_soon':     return 'Termín se blíží. Akce je nutná dnes nebo zítra.'
    case 'blocking':     return 'Tento úkol blokuje postup dealu. Dokončení odblokuje další kroky.'
    case 'has_slack':    return 'Deal postupuje dobře, ale je dobré udržovat tempo.'
    default:             return 'Akce je doporučena na základě stavu dealu.'
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildCardPrompt(
  task: ScoredTask,
  fallbackCardType: 'REPLY' | 'SCHEDULE' | 'TODO',
  beliefs: string[],
  language: string
): string {
  const entityLines = Object.entries(task.entityMapSnapshot)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n') || '  (no entity data yet)'

  const beliefLines = beliefs.length > 0
    ? beliefs.map(b => `  - ${b}`).join('\n')
    : '  (no beliefs recorded yet)'

  const deadline = task.deadline
    ? `Deadline: ${new Date(task.deadline).toLocaleString('sv-SE', { timeZone: 'Europe/Prague' }).slice(0, 16)}`
    : task.slack !== null
      ? `Slack: ${task.slack.toFixed(1)} hours until deadline`
      : task.hoursUntilDue !== null
        ? `Hours until due: ${task.hoursUntilDue.toFixed(1)}`
        : 'No deadline set'

  const cpMessageBlock = task.taskType === 'inbound_reply' && task.latestInboundText
    ? `

CP's latest inbound message (what you are replying to):
"""
${task.latestInboundText.slice(0, 2000)}
"""

REPLY grounding rules (MUST follow for inbound_reply):
- Identify the questions the CP literally asked in the message above.
- For each question, attempt to answer from the entity map facts.
- Questions you CAN answer from entity map → include the answer directly in draft_skeleton, NO placeholder.
- Questions you CANNOT answer from entity map → add a SHORT fact LABEL (1–3 words, lowercase_snake_case) to "placeholders" and reference it as {{ placeholder }} in draft_skeleton. Label names the MISSING FACT, never a question or sentence.
  - Good: {{ delivery_date }}, {{ document_status }}, {{ final_price }}
  - Bad: {{ status_dokumentů_a_očekávaný_čas_dodání }} (that's the CP's question, not a fact label)
  - Bad: {{ do_you_want_to_proceed }} (that's a question to the user, not a missing fact)
- NEVER invent questions the CP did not ask.
- NEVER add verification/confirmation questions ("Confirmed X?", "Did you send Y?").
- NEVER restate the CP's own deadlines as questions back to them.
- If the CP asked no questions, "placeholders" MUST be [] and draft_skeleton is a plain acknowledgment/next-step.`
    : ''

  return `You are generating an action card for a real estate agent's deal management system.

Deal context:
  Task type: ${task.taskType}
  Graph node: ${task.nodeLabel ?? '(no node — lead tracking task)'}
  Score: ${task.score.toFixed(1)}
  ${deadline}

Entity map (known facts about this deal):
${entityLines}

Current beliefs about this counterparty:
${beliefLines}${cpMessageBlock}

Your task: Determine the correct action type AND generate a concise, actionable card in ${language}.

Return a JSON object with these fields:
- "card_type": one of "REPLY", "SCHEDULE", or "TODO"
  - "REPLY" = the agent needs to contact the counterparty (email, call, message)
  - "SCHEDULE" = a meeting or appointment needs to be arranged (look for venue/time in entity map)
  - "TODO" = an internal task the agent must complete (documents, research, preparation)
- "intent_cs": one sentence (max 20 words) describing what needs to happen RIGHT NOW
- "rationale_cs": one sentence explaining WHY this is urgent/important
- "draft_skeleton": if card_type is REPLY, a brief message skeleton (2-3 sentences, use {{ placeholder }} for unknowns). Otherwise null.
- "placeholders": array of strings naming each {{ placeholder }} used (empty array if none)
- "weight": integer 1-10 estimating how hard it would be to reschedule this action (1=trivial, 10=very hard to move). For meetings with external parties or deadlines, use 6-8. For internal tasks, use 2-4. For court dates or notary appointments, use 10.

${task.meetingContext ? `CP's latest message references an upcoming ${task.meetingContext}${task.hoursUntilDue !== null ? ` (in ${task.hoursUntilDue.toFixed(1)} hours)` : ''}. If this is a concrete meeting to attend or confirm, card_type MUST be SCHEDULE, not REPLY.\n\n` : ''}Rules:
- Write ALL text in ${language}
- For intent_cs: use action verbs, be direct (e.g. "Zavolat Novákovi ohledně ceny" not "Je nutné zvážit možnost...")
- card_type priority: SCHEDULE beats REPLY when the CP's message names a specific meeting/signing/viewing/notary appointment with a time — the next action is to confirm/attend the meeting, not to write prose back.
- If entity map contains meeting_venue or address AND a specific time, card_type should be SCHEDULE
- If the graph node is about viewings/meetings/showings AND venue/time data exists, card_type should be SCHEDULE
- REPLY only when there is no concrete meeting to confirm — CP asked a question, made a request, or needs information.
- Add {{ placeholder }} only when the specific detail is MISSING from entity map
- Keep intent_cs under 20 words

CRITICAL: Return only valid JSON, no markdown fences.`
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Generate action cards from scored tasks.
 * One LLM call per task. Fails open on error.
 *
 * @param scoredTasks       Output from scoreWalkerOutput(), top-N for the brief
 * @param settings          User settings (language, tone)
 * @param existingDealTypes Set of "dealId:cardType" keys for deals that already have a pending
 *                          action — skips the LLM call for those, since insertCardsAsActions
 *                          would discard them anyway.
 */
export async function generateCards(
  scoredTasks: ScoredTask[],
  settings: UserSettings,
  existingDealTypes?: Set<string>
): Promise<ActionCard[]> {
  if (scoredTasks.length === 0) return []

  const language = settings.ai_language ?? 'Czech'

  // Process all tasks in parallel — each is independent
  const results = await Promise.allSettled(
    scoredTasks.map(async (task): Promise<ActionCard | null> => {
      const fallbackCardType = deriveCardType(task.taskType)
      const urgency = deriveUrgency(task, task.hoursUntilDue)

      // Skip LLM if a pending action already exists for this deal+type.
      // insertCardsAsActions would discard it anyway — no point generating text.
      // Check all 3 possible card types since the LLM determines the final type.
      if (existingDealTypes?.has(`${task.dealId}:REPLY`) &&
          existingDealTypes?.has(`${task.dealId}:SCHEDULE`) &&
          existingDealTypes?.has(`${task.dealId}:TODO`)) return null

      // Load current beliefs for tone tailoring
      let beliefs: string[] = task.beliefSnapshot ?? []
      try {
        const journalBeliefs = await getCurrentBeliefs(task.dealId)
        if (journalBeliefs.length > 0) {
          beliefs = journalBeliefs
            .slice(0, 5)
            .map(b => `[${b.topic}] ${b.content}`)
        }
      } catch {
        // Use beliefSnapshot from walker output if DB call fails
      }

      const prompt = buildCardPrompt(task, fallbackCardType, beliefs, language)

      try {
        const raw = await runAITask('drafting', prompt)

        let parsed: {
          card_type?: string
          intent_cs?: string
          rationale_cs?: string
          draft_skeleton?: string | null
          placeholders?: string[]
          weight?: number
        }
        try {
          // Take first JSON block — Gemini sometimes wraps in markdown fences
          const jsonMatch = raw.match(/\{[\s\S]*\}/)
          parsed = JSON.parse(jsonMatch?.[0] ?? raw)
        } catch {
          return buildFallbackCard(task, fallbackCardType, urgency, beliefs)
        }

        // Validate LLM-determined card type, fall back to deterministic derivation
        const validTypes = ['REPLY', 'SCHEDULE', 'TODO'] as const
        const llmCardType = parsed.card_type?.toUpperCase()
        const cardType: 'REPLY' | 'SCHEDULE' | 'TODO' =
          validTypes.includes(llmCardType as typeof validTypes[number])
            ? llmCardType as 'REPLY' | 'SCHEDULE' | 'TODO'
            : fallbackCardType

        // Skip if this specific deal+type already has a pending action
        if (existingDealTypes?.has(`${task.dealId}:${cardType}`)) return null

        // Extract venue/time from entity map for SCHEDULE cards
        const meetingVenue = extractVenueFromEntityMap(task.entityMapSnapshot)
        const proposedTime = extractTimeFromEntityMap(task.entityMapSnapshot)

        const weight = typeof parsed.weight === 'number'
          ? Math.min(10, Math.max(1, Math.round(parsed.weight)))
          : null

        return {
          nodeId:              task.nodeId,
          dealId:              task.dealId,
          taskType:            task.taskType,
          score:               task.score + (weight ?? 0),
          scoreBreakdown:      task.scoreBreakdown,
          cpId:                task.cpId,
          entityMapSnapshot:   task.entityMapSnapshot,
          beliefSnapshot:      beliefs,
          meetingVenue:        cardType === 'SCHEDULE' ? meetingVenue : null,
          proposedTime:        cardType === 'SCHEDULE' ? proposedTime : null,
          weight,
          card_type:           cardType,
          intent_cs:           (parsed.intent_cs ?? defaultIntentCs(task.taskType)).slice(0, 200),
          rationale_cs:        parsed.rationale_cs ?? defaultRationaleCs(task.taskType),
          draft_skeleton:      cardType === 'REPLY' ? (parsed.draft_skeleton ?? null) : null,
          placeholders:        Array.isArray(parsed.placeholders) ? parsed.placeholders : [],
          urgency,
        }
      } catch {
        // LLM unavailable — fail open
        return buildFallbackCard(task, fallbackCardType, urgency, beliefs)
      }
    })
  )

  // Collect fulfilled cards — failed tasks and skipped (null) cards are dropped
  return results
    .filter((r): r is PromiseFulfilledResult<ActionCard> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value as ActionCard)
}

// ─── Entity map venue/time extraction ────────────────────────────────────────

/** Find a meeting venue from entity map keys (meeting_venue.*, address.*) */
function extractVenueFromEntityMap(entityMap: Record<string, string>): string | null {
  // meeting_venue keys take priority (explicitly about where people meet)
  for (const [key, value] of Object.entries(entityMap)) {
    if (key.startsWith('meeting_venue.') && value) return value
  }
  // Fall back to address keys
  for (const [key, value] of Object.entries(entityMap)) {
    if (key.startsWith('address.') && value) return value
  }
  return null
}

/** Find a proposed meeting time from entity map keys (deadline.*meeting*, deadline.*viewing*) */
function extractTimeFromEntityMap(entityMap: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(entityMap)) {
    if (key.startsWith('deadline.') && /meeting|viewing|schůzk|prohlídk/i.test(key) && value) {
      return value
    }
  }
  return null
}

// ─── Helper ───────────────────────────────────────────────────────────────────

// ─── DB insertion ─────────────────────────────────────────────────────────────

/** Parse CZK currency strings: "4 500 000 Kč" → 4500000 */
function parseCurrencyValue(value: string): number {
  const cleaned = value.replace(/[^\d.]/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

/**
 * Insert ActionCards as action_proposals in the database.
 *
 * Resolution strategy:
 * 1. Find the most recent conversation for each deal (via conversation_threads.deal_id)
 *    Falls back to treating deal_id as conversation_id for backfilled 1:1 data.
 * 2. Get cp_id from card.cpId or from the conversation's first participant.
 * 3. Dedup: skip if a pending action of the same type already exists for this deal.
 * 4. Insert via createAction().
 *
 * Cards that can't be resolved (no conversation, no cp) are silently skipped.
 */
export async function insertCardsAsActions(
  userId: string,
  cards: ActionCard[]
): Promise<ActionProposal[]> {
  if (cards.length === 0) return []

  const supabase = getSupabaseAdmin()
  const inserted: ActionProposal[] = []

  // Pre-fetch: which deal+type combos already have a pending action?
  // All cards now use real deal UUIDs (no more triage-path conv UUID fallback).
  const { data: existingRows } = await supabase
    .from('action_proposals')
    .select('deal_id, action_type')
    .eq('user_id', userId)
    .eq('status', 'pending')

  const existingDealTypes = new Set<string>()
  for (const r of existingRows ?? []) {
    if (r.deal_id) existingDealTypes.add(`${r.deal_id}:${r.action_type}`)
  }

  for (const card of cards) {
    try {
      // Skip if same type is already pending for this deal
      const dedupeKey = `${card.dealId}:${card.card_type}`
      if (existingDealTypes.has(dedupeKey)) continue

      // Find conversation via deal_timeline — the authoritative deal→conversation link.
      // deal_timeline.deal_id is always set by deal-tagger; conversation_threads.deal_id is not.
      let conversationId: string | null = null
      const resolvedDealId: string = card.dealId
      const { data: timelineRow } = await supabase
        .from('deal_timeline')
        .select('conversation_id')
        .eq('deal_id', card.dealId)
        .not('conversation_id', 'is', null)
        .order('occurred_at', { ascending: false })
        .limit(1)

      if (timelineRow && timelineRow.length > 0) {
        conversationId = timelineRow[0].conversation_id
      }

      if (!conversationId) {
        console.warn(`[CardGenerator] No conversation found for deal ${card.dealId} — skipping`)
        continue
      }

      // Get cp_id: from card first, else from conversation participants
      let cpId = card.cpId
      if (!cpId) {
        const participants = await getParticipants(conversationId)
        cpId = participants[0]?.cp_id ?? null
      }
      if (!cpId) continue  // Can't insert without cp_id

      // Dollar value from entity map
      const priceStr = card.entityMapSnapshot['price.asking_price']
        ?? card.entityMapSnapshot['price.sale_price']
        ?? '0'
      const dollarValue = parseCurrencyValue(priceStr)

      const action = await createAction({
        id: uuidv4(),
        user_id: userId,
        conversation_id: conversationId,
        cp_id: cpId,
        deal_id: resolvedDealId,
        action_type: card.card_type,
        status: 'pending',
        intent_cs: card.intent_cs,
        rationale_cs: card.rationale_cs,
        rationale: card.rationale_cs,  // Czech is fine for internal field
        missing_info: card.placeholders.length > 0
          ? card.placeholders.map(p => ({ label: p, value: null }))
          : null,
        priority_score: card.score,
        dollar_value: dollarValue,
        urgency: card.urgency,
        weight: card.weight ?? (card.scoreBreakdown.immovability || null),
        offer_multiplier: null,
        draft_subject: null,
        draft_body_text: null,
        queued_for_brief: true,
        payload: {
          urgency: card.urgency,
          taskType: card.taskType,
          channel: 'email',
          placeholders: card.placeholders,
          has_draft_skeleton: card.draft_skeleton !== null,
          ...(card.card_type === 'SCHEDULE' ? {
            // Use 'suggestedTime' — the key the optimizer reads (not 'proposed_time')
            suggestedTime: card.proposedTime ?? undefined,
            suggestedLocation: card.meetingVenue ?? undefined,
            meeting_type: 'address',
          } : {}),
        },
      })

      inserted.push(action)
      // Track inserted for same-run dedup
      existingDealTypes.add(dedupeKey)
    } catch (err) {
      console.warn(`[CardGenerator] Failed to insert card for deal ${card.dealId}:`, err)
    }
  }

  return inserted
}

function buildFallbackCard(
  task: ScoredTask,
  cardType: 'REPLY' | 'SCHEDULE' | 'TODO',
  urgency: number,
  beliefs: string[]
): ActionCard {
  return {
    nodeId:              task.nodeId,
    dealId:              task.dealId,
    taskType:            task.taskType,
    score:               task.score,
    scoreBreakdown:      task.scoreBreakdown,
    cpId:                task.cpId,
    entityMapSnapshot:   task.entityMapSnapshot,
    beliefSnapshot:      beliefs,
    meetingVenue:        cardType === 'SCHEDULE' ? extractVenueFromEntityMap(task.entityMapSnapshot) : null,
    proposedTime:        cardType === 'SCHEDULE' ? extractTimeFromEntityMap(task.entityMapSnapshot) : null,
    weight:              null,
    card_type:           cardType,
    intent_cs:         defaultIntentCs(task.taskType),
    rationale_cs:      defaultRationaleCs(task.taskType),
    draft_skeleton:    null,
    placeholders:      [],
    urgency,
  }
}
