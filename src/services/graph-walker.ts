/**
 * Graph Walker (Chunk 8a — Phase 3.1)
 *
 * Pure deterministic traversal — no LLM, no scoring.
 * Walks every active deal's DAG against current time and outputs ranked tasks.
 *
 * Replaces (eventually, in Chunk 10):
 *   - planning.ts → generateActionsForConversations()
 *   - lead-tracking.ts → trackLeadsForUser()
 */

import { getDealsForUser } from '@/lib/db/deals'
import { getDAG, getBlockingNodes } from '@/lib/db/deal-graph'
import { getEntitiesForDeal } from '@/lib/db/entity-map'
import { getCurrentBeliefs } from '@/lib/db/journal'
import { getParticipantsForDeal } from '@/lib/db/deal-participants'
import { getLatestInboundFromCP } from '@/lib/db/timeline'
import { hasPendingActionForCP } from '@/lib/db/actions'
import { getMessageById } from '@/lib/db/messages'
import { parseEnrichedText } from '@/lib/ai/tasks'
import type { UserSettings, Deal, DealGraphNode, DealGraphEdge } from '@/lib/supabase/types'

// ─── Output types ─────────────────────────────────────────────────────────────

export type WalkerTaskType =
  | 'blocking'
  | 'due_soon'
  | 'overdue'
  | 'has_slack'
  | 'calendar_conflict'
  | 'lead_cooling'
  | 'lead_cold'
  | 'lead_dead'
  | 'inbound_reply'

export interface WalkerTask {
  /** Node ID, or 'deal:lead' for deal-level lead tracking tasks */
  nodeId: string
  dealId: string
  taskType: WalkerTaskType
  /** Human-readable label of the graph node (e.g. "Property viewings", "Purchase contract") */
  nodeLabel: string | null
  deadline: string | null
  /** Hours until deadline — negative means overdue */
  hoursUntilDue: number | null
  /** Hours of slack before this becomes urgent (null = already urgent) */
  slack: number | null
  cpId: string | null
  /** Relevant hard facts: "price.asking_price" → "4 500 000 Kč" */
  entityMapSnapshot: Record<string, string>
  /** Current deal beliefs — latest content per topic */
  beliefSnapshot: string[]
  /** CP's latest inbound message text — only set for 'inbound_reply' */
  latestInboundText?: string
  /** Urgency signal parsed from message enrichment — only set for 'inbound_reply' */
  enrichmentSignal?: 'HARD DEADLINE' | 'SOFT REFERENCE' | null
}

export interface GraphWalkerOutput {
  dealId: string
  deal: Deal
  tasks: WalkerTask[]
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DUE_SOON_HOURS = 24   // deadline within this many hours
const HAS_SLACK_HOURS = 72  // deadline beyond this many hours but node is blocking

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Walk all active deals for a user.
 * Returns one GraphWalkerOutput per deal that has actionable tasks.
 * Deals with zero tasks are omitted.
 */
export async function walkAllDeals(userId: string, settings: UserSettings): Promise<GraphWalkerOutput[]> {
  const deals = await getDealsForUser(userId, { status: 'active' })
  if (deals.length === 0) return []

  const results: GraphWalkerOutput[] = []
  const now = new Date()

  await Promise.allSettled(
    deals.map(async (deal) => {
      try {
        const tasks = await walkOneDeal(deal, now, settings)
        if (tasks.length > 0) {
          results.push({ dealId: deal.id, deal, tasks })
        }
      } catch (err) {
        console.warn(`[GraphWalker] Failed to walk deal ${deal.id}:`, err)
      }
    })
  )

  return results
}

// ─── Per-deal walking ─────────────────────────────────────────────────────────

async function walkOneDeal(
  deal: Deal,
  now: Date,
  settings: UserSettings
): Promise<WalkerTask[]> {
  const tasks: WalkerTask[] = []

  // Load shared context once
  const [entities, beliefs] = await Promise.all([
    getEntitiesForDeal(deal.id),
    getCurrentBeliefs(deal.id),
  ])

  const entityMapSnapshot: Record<string, string> = {}
  for (const e of entities) {
    entityMapSnapshot[`${e.entity_type}.${e.entity_key}`] = e.entity_value
  }
  const beliefSnapshot = beliefs.map(b => b.content)

  // ── Graph-based tasks ────────────────────────────────────────────────────────
  const dag = await getDAG(deal.id)
  if (dag.nodes.length > 0) {
    const graphTasks = classifyNodes(deal.id, dag.nodes, dag.edges, entityMapSnapshot, beliefSnapshot, now)
    tasks.push(...graphTasks)
  }

  // ── Lead tracking ────────────────────────────────────────────────────────────
  const leadTask = classifyLeadStatus(deal, entityMapSnapshot, beliefSnapshot, now, settings)
  if (leadTask) tasks.push(leadTask)

  // ── Inbound reply detection ─────────────────────────────────────────────────
  const replyTask = await classifyInboundReply(deal, entityMapSnapshot, beliefSnapshot, now)
  if (replyTask) tasks.push(replyTask)

  return tasks
}

// ─── Node classification ──────────────────────────────────────────────────────

function classifyNodes(
  dealId: string,
  nodes: DealGraphNode[],
  edges: DealGraphEdge[],
  entityMapSnapshot: Record<string, string>,
  beliefSnapshot: string[],
  now: Date
): WalkerTask[] {
  const tasks: WalkerTask[] = []

  // Build set of completed node IDs for upstream checking
  const completedIds = new Set(nodes.filter(n => n.status === 'completed').map(n => n.id))

  for (const node of nodes) {
    // Skip completed and skipped nodes
    if (node.status === 'completed' || node.status === 'skipped') continue

    const deadline = node.deadline ? new Date(node.deadline) : null
    const hoursUntilDue = deadline ? (deadline.getTime() - now.getTime()) / (1000 * 60 * 60) : null

    // Determine task type
    let taskType: WalkerTaskType

    if (deadline && hoursUntilDue !== null && hoursUntilDue < 0) {
      taskType = 'overdue'
    } else if (deadline && hoursUntilDue !== null && hoursUntilDue <= DUE_SOON_HOURS) {
      taskType = 'due_soon'
    } else {
      // Check if this node is blocking (all upstream depends_on edges are satisfied)
      if (!isNodeUnblocked(node, edges, completedIds)) continue

      if (hoursUntilDue !== null && hoursUntilDue > HAS_SLACK_HOURS) {
        taskType = 'has_slack'
      } else {
        taskType = 'blocking'
      }
    }

    tasks.push({
      nodeId: node.id,
      dealId,
      taskType,
      nodeLabel: node.label,
      deadline: node.deadline,
      hoursUntilDue: hoursUntilDue !== null ? Math.round(hoursUntilDue * 10) / 10 : null,
      slack: computeSlack(hoursUntilDue),
      cpId: node.cp_id,
      entityMapSnapshot,
      beliefSnapshot,
    })
  }

  return tasks
}

/**
 * Returns true if the node is pending and all its upstream depends_on edges are satisfied.
 * Nodes with no upstream edges are always unblocked (nothing is blocking them).
 */
function isNodeUnblocked(
  node: DealGraphNode,
  edges: DealGraphEdge[],
  completedIds: Set<string>
): boolean {
  if (node.status !== 'pending') return false

  const upstreamEdges = edges.filter(e => e.to_node_id === node.id && e.edge_type === 'depends_on')
  return upstreamEdges.every(e => completedIds.has(e.from_node_id))
}

function computeSlack(hoursUntilDue: number | null): number | null {
  if (hoursUntilDue === null) return null
  if (hoursUntilDue <= 0) return null    // overdue — no slack
  if (hoursUntilDue <= DUE_SOON_HOURS) return null  // due soon — treat as 0 slack
  return Math.round((hoursUntilDue - DUE_SOON_HOURS) * 10) / 10
}

// ─── Lead tracking ────────────────────────────────────────────────────────────

function classifyLeadStatus(
  deal: Deal,
  entityMapSnapshot: Record<string, string>,
  beliefSnapshot: string[],
  now: Date,
  settings: UserSettings
): WalkerTask | null {
  if (!deal.last_activity_at) return null

  const lastActivity = new Date(deal.last_activity_at)
  const daysInactive = (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)

  let taskType: WalkerTaskType | null = null
  if (daysInactive >= settings.dead_threshold_days) {
    taskType = 'lead_dead'
  } else if (daysInactive >= settings.cold_threshold_days) {
    taskType = 'lead_cold'
  } else if (daysInactive >= settings.cooling_threshold_days) {
    taskType = 'lead_cooling'
  }

  if (!taskType) return null

  return {
    nodeId: `deal:${deal.id}:lead`,
    dealId: deal.id,
    taskType,
    nodeLabel: null,
    deadline: null,
    hoursUntilDue: null,
    slack: null,
    cpId: null,
    entityMapSnapshot,
    beliefSnapshot,
  }
}

// ─── Inbound reply detection ──────────────────────────────────────────────────

const INBOUND_REPLY_FRESHNESS_DAYS = 14

async function classifyInboundReply(
  deal: Deal,
  entityMapSnapshot: Record<string, string>,
  beliefSnapshot: string[],
  now: Date,
): Promise<WalkerTask | null> {
  try {
    const participants = await getParticipantsForDeal(deal.id)
    if (participants.length === 0) return null

    let bestCpId: string | null = null
    let bestTs = 0
    let bestMessageId: string | null = null
    for (const p of participants) {
      const latest = await getLatestInboundFromCP(deal.user_id, p.cp_id)
      if (!latest?.occurred_at) continue
      const ts = new Date(latest.occurred_at).getTime()
      if (ts > bestTs) {
        bestTs = ts
        bestCpId = p.cp_id
        bestMessageId = latest.message_id
      }
    }
    if (!bestCpId || bestTs === 0) return null

    const daysSince = (now.getTime() - bestTs) / (1000 * 60 * 60 * 24)
    if (daysSince > INBOUND_REPLY_FRESHNESS_DAYS) return null

    if (await hasPendingActionForCP(deal.user_id, bestCpId)) return null

    // Pull message text + enrichment signal for downstream urgency + drafting
    let latestInboundText: string | undefined
    let enrichmentSignal: 'HARD DEADLINE' | 'SOFT REFERENCE' | null = null
    if (bestMessageId) {
      const msg = await getMessageById(bestMessageId)
      if (msg) {
        latestInboundText = msg.cleaned_text || msg.raw_text || undefined
        if (msg.enriched_text) {
          const enrichment = parseEnrichedText(msg.enriched_text)
          const cls = enrichment?.urgency?.classification
          if (cls === 'HARD DEADLINE' || cls === 'SOFT REFERENCE') {
            enrichmentSignal = cls
          }
        }
      }
    }

    return {
      nodeId: `deal:${deal.id}:reply`,
      dealId: deal.id,
      taskType: 'inbound_reply',
      nodeLabel: null,
      deadline: null,
      hoursUntilDue: null,
      slack: null,
      cpId: bestCpId,
      entityMapSnapshot,
      beliefSnapshot,
      latestInboundText,
      enrichmentSignal,
    }
  } catch (err) {
    console.warn(`[GraphWalker] inbound_reply classify failed for deal ${deal.id}:`, err)
    return null
  }
}

// ─── Convenience re-export ────────────────────────────────────────────────────

export { getBlockingNodes }
