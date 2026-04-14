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

import { runAITask } from '@/lib/ai/runner'
import { getCurrentBeliefs } from '@/lib/db/journal'
import type { UserSettings } from '@/lib/supabase/types'
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
