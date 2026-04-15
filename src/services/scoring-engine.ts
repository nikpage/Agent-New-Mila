/**
 * Scoring Engine (Chunk 8b — Phase 3.2)
 *
 * Pure deterministic scoring — no LLM.
 * Takes graph walker output and applies business rules to rank tasks.
 *
 * Formula: dealImportance + timePressure + graphPressure + immovability + anomalyBoost
 *
 * Preserves the core score structure from calculatePriorityScore() in lib/db/actions.ts.
 * Inputs now come from the entity map and graph, not per-message AI triage.
 */

import { selectOfferMultiplier } from '@/shared/scoring'
import type { UserSettings, Deal } from '@/lib/supabase/types'
import type { WalkerTask, WalkerTaskType, GraphWalkerOutput } from './graph-walker'

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  dealImportance: number
  timePressure: number
  graphPressure: number
  immovability: number
  anomalyBoost: number
}

export interface ScoredTask extends WalkerTask {
  score: number
  scoreBreakdown: ScoreBreakdown
}

// ─── Urgency mapping ──────────────────────────────────────────────────────────

/** Derive urgency (1–10) from taskType + deadline proximity. No AI involved. */
function deriveUrgency(task: WalkerTask): number {
  switch (task.taskType) {
    case 'overdue':          return 10
    case 'due_soon':
      // Scale: < 4h = 9, 4-24h = 8
      if (task.hoursUntilDue !== null && task.hoursUntilDue < 4) return 9
      return 8
    case 'blocking':         return 7
    case 'lead_dead':        return 7
    case 'lead_cold':        return 5
    case 'lead_cooling':     return 3
    case 'has_slack':        return 2
    case 'calendar_conflict': return 6
    case 'triage_action':    return task.triageUrgency ?? 5
    default:                 return 1
  }
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Score all walker tasks across all deals.
 *
 * @param walkerOutputs  Output from walkAllDeals()
 * @param dealMap        Map<dealId, Deal> — for last_activity_at and anomaly_boost
 * @param settings       User settings (thresholds, multipliers, kcHighValue)
 */
export function scoreWalkerOutput(
  walkerOutputs: GraphWalkerOutput[],
  settings: UserSettings,
  triageTasks: WalkerTask[] = []
): ScoredTask[] {
  const scored: ScoredTask[] = []

  for (const output of walkerOutputs) {
    const deal = output.deal
    const entityMap = output.tasks[0]?.entityMapSnapshot ?? {}

    // Dollar value from entity map
    const dollarValueStr = entityMap['price.asking_price'] ?? entityMap['price.sale_price'] ?? '0'
    const dollarValue = parseCurrency(dollarValueStr)

    // nVal: percentage-based normalization (floor 1)
    const kcHighValue = settings.kc_high_value ?? 5_000_000
    const nVal = Math.max(1, Math.round((dollarValue / kcHighValue) * 10))

    // Role multiplier from user_role on the deal
    const sellerMul = settings.offer_multiplier_seller ?? 1.5
    const buyerMul  = settings.offer_multiplier_buyer  ?? 1.0
    const roleMultiplier = selectOfferMultiplier(deal.user_role as 'seller' | 'buyer' | null, sellerMul, buyerMul)

    // Days since last activity (same ^1.5 curve as old formula)
    const daysIgnored = computeDaysIgnored(deal.last_activity_at)

    // Anomaly boost from deal record
    const anomalyBoost = deal.anomaly_boost ?? 0

    for (const task of output.tasks) {
      const urgency    = deriveUrgency(task)
      const dealImportance = nVal * roleMultiplier
      const timePressure   = urgency * Math.pow(Math.max(0, daysIgnored), 1.5)
      const graphPressure  = computeGraphPressure(task)
      const immovability   = 0  // populated from entity map in later chunks

      const score = dealImportance + timePressure + graphPressure + immovability + anomalyBoost

      scored.push({
        ...task,
        score: Math.round(score * 100) / 100,
        scoreBreakdown: {
          dealImportance: Math.round(dealImportance * 100) / 100,
          timePressure:   Math.round(timePressure   * 100) / 100,
          graphPressure:  Math.round(graphPressure  * 100) / 100,
          immovability,
          anomalyBoost,
        },
      })
    }
  }

  // Score triage tasks — no deal context available, use stub deal values.
  // daysIgnored is derived from urgency_category so CRITICAL/TODAY tasks rank above
  // lead tracking tasks (which use actual staleness days). This reflects that a CRITICAL
  // email deadline is more pressing than a cold lead ignored for weeks.
  for (const task of triageTasks) {
    const urgency = deriveUrgency(task)
    // Map urgency to effective daysIgnored: CRITICAL=15, TODAY=10, THIS_WEEK=5, SOON=2, NONE=0.5
    const effectiveDays = urgency >= 9 ? 15 : urgency >= 8 ? 10 : urgency >= 6 ? 5 : urgency >= 4 ? 2 : 0.5
    const timePressure = urgency * Math.pow(effectiveDays, 1.5)
    const score = 1 + timePressure // dealImportance stub=1, immovability=0, anomalyBoost=0
    scored.push({
      ...task,
      score: Math.round(score * 100) / 100,
      scoreBreakdown: {
        dealImportance: 1,
        timePressure:   Math.round(timePressure * 100) / 100,
        graphPressure:  0,
        immovability:   0,
        anomalyBoost:   0,
      },
    })
  }

  // Sort descending by score
  return scored.sort((a, b) => b.score - a.score)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse CZK currency strings: "4 500 000 Kč" → 4500000 */
function parseCurrency(value: string): number {
  const cleaned = value.replace(/[^\d.]/g, '')
  const parsed = parseFloat(cleaned)
  return isNaN(parsed) ? 0 : parsed
}

/**
 * Days since last deal activity. Same fallback chain as shared/scoring.ts:
 * last_activity_at → now (0 days). Clamps to Math.max(0, ...).
 */
function computeDaysIgnored(lastActivityAt: string | null): number {
  if (!lastActivityAt) return 0
  const ms = Date.now() - new Date(lastActivityAt).getTime()
  return Math.max(0, ms / (1000 * 60 * 60 * 24))
}

/**
 * Graph-level pressure: extra points for tasks that are actively blocking
 * downstream work (overdue or blocking type = deal is stalled).
 */
function computeGraphPressure(task: WalkerTask): number {
  if (task.taskType === 'overdue' || task.taskType === 'blocking') return 2
  if (task.taskType === 'due_soon') return 1
  return 0
}
