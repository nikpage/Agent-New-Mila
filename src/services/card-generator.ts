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

  // Generated card fields
  card_type: 'REPLY' | 'SCHEDULE' | 'TODO'
  intent_cs: string
  rationale_cs: string
  draft_skeleton: string | null   // REPLY only — skeleton for generateFinalDraft()
  placeholders: string[]          // {{ placeholder }} items the system couldn't fill
  urgency: number                 // derived from taskType (same as scoring-engine)
}

// ─── Card type derivation ─────────────────────────────────────────────────────

export function deriveCardType(taskType: WalkerTaskType): 'REPLY' | 'SCHEDULE' | 'TODO' {
  if (taskType === 'lead_cooling' || taskType === 'lead_cold' || taskType === 'lead_dead') {
    return 'REPLY'
  }
  if (taskType === 'calendar_conflict') {
    return 'SCHEDULE'
  }
  return 'TODO'
}

// ─── Urgency mapping (mirrors scoring-engine) ─────────────────────────────────

function deriveUrgency(taskType: WalkerTaskType, hoursUntilDue: number | null): number {
  switch (taskType) {
    case 'overdue':          return 10
    case 'due_soon':
      return (hoursUntilDue !== null && hoursUntilDue < 4) ? 9 : 8
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
  cardType: 'REPLY' | 'SCHEDULE' | 'TODO',
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
    ? `Deadline: ${new Date(task.deadline).toISOString().slice(0, 16)}`
    : task.slack !== null
      ? `Slack: ${task.slack.toFixed(1)} hours until deadline`
      : task.hoursUntilDue !== null
        ? `Hours until due: ${task.hoursUntilDue.toFixed(1)}`
        : 'No deadline set'

  const draftInstructions = cardType === 'REPLY'
    ? `
Also generate a "draft_skeleton": a short Czech email/message skeleton (2–3 sentences max).
Use {{ placeholder }} for any specific detail you don't know (e.g. specific dates, names, prices).
Keep it natural and warm, not robotic.`
    : `Set "draft_skeleton" to null.`

  return `You are generating an action card for a real estate agent's deal management system.

Deal context:
  Task type: ${task.taskType}
  Card type: ${cardType}
  Score: ${task.score.toFixed(1)}
  ${deadline}

Entity map (known facts about this deal):
${entityLines}

Current beliefs about this counterparty:
${beliefLines}

Your task: Generate a concise, actionable card in ${language}.

Return a JSON object with these fields:
- "intent_cs": one sentence (max 20 words) describing what needs to happen RIGHT NOW
- "rationale_cs": one sentence explaining WHY this is urgent/important
- "draft_skeleton": ${cardType === 'REPLY' ? 'a brief message skeleton (2-3 sentences, use {{ placeholder }} for unknowns)' : 'null'}
- "placeholders": array of strings naming each {{ placeholder }} used (empty array if none)

Rules:
- Write ALL text in ${language}
- For intent_cs: use action verbs, be direct (e.g. "Zavolat Novákovi ohledně ceny" not "Je nutné zvážit možnost...")
- For REPLY cards: the agent needs to reach out to the counterparty
- For SCHEDULE cards: the agent needs to resolve a calendar conflict
- For TODO cards: the agent needs to complete an internal task
- Add {{ placeholder }} only when the specific detail is MISSING from entity map
- Keep intent_cs under 20 words

CRITICAL: Return only valid JSON, no markdown fences.`
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Generate action cards from scored tasks.
 * One LLM call per task. Fails open on error.
 *
 * @param scoredTasks  Output from scoreWalkerOutput(), top-N for the brief
 * @param settings     User settings (language, tone)
 */
export async function generateCards(
  scoredTasks: ScoredTask[],
  settings: UserSettings
): Promise<ActionCard[]> {
  if (scoredTasks.length === 0) return []

  const language = settings.ai_language ?? 'Czech'

  // Process all tasks in parallel — each is independent
  const results = await Promise.allSettled(
    scoredTasks.map(async (task): Promise<ActionCard> => {
      const cardType = deriveCardType(task.taskType)
      const urgency = deriveUrgency(task.taskType, task.hoursUntilDue)

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

      const prompt = buildCardPrompt(task, cardType, beliefs, language)

      try {
        const raw = await runAITask('drafting', prompt)

        let parsed: {
          intent_cs?: string
          rationale_cs?: string
          draft_skeleton?: string | null
          placeholders?: string[]
        }
        try {
          parsed = JSON.parse(raw)
        } catch {
          // LLM returned non-JSON — use defaults
          return buildFallbackCard(task, cardType, urgency, beliefs)
        }

        return {
          nodeId:              task.nodeId,
          dealId:              task.dealId,
          taskType:            task.taskType,
          score:               task.score,
          scoreBreakdown:      task.scoreBreakdown,
          cpId:                task.cpId,
          entityMapSnapshot:   task.entityMapSnapshot,
          beliefSnapshot:      beliefs,
          card_type:           cardType,
          intent_cs:           (parsed.intent_cs ?? defaultIntentCs(task.taskType)).slice(0, 200),
          rationale_cs:        parsed.rationale_cs ?? defaultRationaleCs(task.taskType),
          draft_skeleton:      cardType === 'REPLY' ? (parsed.draft_skeleton ?? null) : null,
          placeholders:        Array.isArray(parsed.placeholders) ? parsed.placeholders : [],
          urgency,
        }
      } catch {
        // LLM unavailable — fail open
        return buildFallbackCard(task, cardType, urgency, beliefs)
      }
    })
  )

  // Collect fulfilled cards — failed tasks are silently dropped (fail-open)
  return results
    .filter((r): r is PromiseFulfilledResult<ActionCard> => r.status === 'fulfilled')
    .map(r => r.value)
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
  // Avoids N queries per card.
  const { data: existingRows } = await supabase
    .from('action_proposals')
    .select('deal_id, action_type')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .not('deal_id', 'is', null)

  const existingDealTypes = new Set<string>(
    (existingRows ?? []).map(r => `${r.deal_id}:${r.action_type}`)
  )

  for (const card of cards) {
    try {
      // Skip if same type is already pending for this deal
      const dedupeKey = `${card.dealId}:${card.card_type}`
      if (existingDealTypes.has(dedupeKey)) continue

      // Find conversation: query by deal_id first, fall back to id = dealId.
      // resolvedDealId tracks whether card.dealId is a real deal UUID or a conversation UUID
      // used as a fallback — the latter must not be written to action_proposals.deal_id.
      let conversationId: string | null = null
      let resolvedDealId: string | null = card.dealId
      const { data: byDealId } = await supabase
        .from('conversation_threads')
        .select('id')
        .eq('user_id', userId)
        .eq('deal_id', card.dealId)
        .order('last_updated', { ascending: false, nullsFirst: false })
        .limit(1)

      if (byDealId && byDealId.length > 0) {
        conversationId = byDealId[0].id
      } else {
        // Fallback: card.dealId is a conversation UUID (e.g. triage tasks where conv.deal_id is null)
        const { data: byId } = await supabase
          .from('conversation_threads')
          .select('id')
          .eq('user_id', userId)
          .eq('id', card.dealId)
          .limit(1)
        if (byId && byId.length > 0) {
          conversationId = byId[0].id
          resolvedDealId = null  // conversation UUID ≠ deal UUID — don't store as FK
        }
      }

      if (!conversationId) continue  // Can't insert without conversation_id

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
        weight: card.scoreBreakdown.immovability || null,
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
    nodeId:            task.nodeId,
    dealId:            task.dealId,
    taskType:          task.taskType,
    score:             task.score,
    scoreBreakdown:    task.scoreBreakdown,
    cpId:              task.cpId,
    entityMapSnapshot: task.entityMapSnapshot,
    beliefSnapshot:    beliefs,
    card_type:         cardType,
    intent_cs:         defaultIntentCs(task.taskType),
    rationale_cs:      defaultRationaleCs(task.taskType),
    draft_skeleton:    null,
    placeholders:      [],
    urgency,
  }
}
