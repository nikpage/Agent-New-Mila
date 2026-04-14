/**
 * Graph Updater (Chunk 6 — Phase 2.3)
 *
 * Two responsibilities:
 *   1. SEED — when a deal has no graph yet, create nodes + edges from the
 *      deal-type template (deterministic, no LLM).
 *   2. UPDATE — when new hard facts arrive, match them to existing nodes and
 *      flip their status (completed / blocked). One LLM call only for facts
 *      that genuinely don't fit any existing node pattern.
 */

import { runAITask } from '@/lib/ai/runner'
import { getDAG, createNode, updateNodeStatus, createEdge } from '@/lib/db/deal-graph'
import { getDealById } from '@/lib/db/deals'
import { getTemplateForDeal } from '@/config/deal-templates'
import type { HardFact } from './fact-extractor'
import type { DealGraphNode } from '@/lib/supabase/types'

// ─── Seeding ─────────────────────────────────────────────────────────────────

/**
 * Seed the DAG for a deal from its type template.
 * Called the first time updateGraph sees a deal with no nodes.
 */
async function seedGraph(userId: string, dealId: string): Promise<void> {
  const deal = await getDealById(dealId)
  if (!deal) throw new Error(`[GraphUpdater] Deal ${dealId} not found`)

  const template = getTemplateForDeal(deal.deal_type, deal.category)

  // Create all nodes
  const createdNodes: DealGraphNode[] = []
  for (const nodeTpl of template.nodes) {
    const node = await createNode({
      deal_id: dealId,
      user_id: userId,
      label: nodeTpl.label,
      node_type: nodeTpl.node_type,
      status: 'pending',
      metadata: { keywords: nodeTpl.keywords },
    })
    createdNodes.push(node)
  }

  // Sequential edges: node[i] → node[i+1] (depends_on)
  for (let i = 0; i < createdNodes.length - 1; i++) {
    await createEdge({
      deal_id: dealId,
      from_node_id: createdNodes[i].id,
      to_node_id: createdNodes[i + 1].id,
      edge_type: 'depends_on',
      source: 'system',
    })
  }

  // Extra edges (non-sequential)
  for (const extra of template.extra_edges ?? []) {
    const from = createdNodes[extra.from]
    const to = createdNodes[extra.to]
    if (from && to) {
      await createEdge({
        deal_id: dealId,
        from_node_id: from.id,
        to_node_id: to.id,
        edge_type: extra.edge_type,
        source: 'system',
      })
    }
  }
}

// ─── Fact → node matching ─────────────────────────────────────────────────────

/**
 * Try to match a hard fact to an existing pending node.
 * Returns the best matching node or null.
 *
 * Matching rules (in priority order):
 *  1. deal_stage fact value matches a node keyword
 *  2. document_state value containing "signed/approved/received" matches a document node keyword
 *  3. commitment/milestone value matches a node keyword
 */
function matchFactToNode(
  fact: HardFact,
  pendingNodes: DealGraphNode[]
): DealGraphNode | null {
  const factValue = fact.value.toLowerCase()
  const factKey   = fact.key.toLowerCase()

  for (const node of pendingNodes) {
    const meta = node.metadata as { keywords?: string[] } | null
    const keywords: string[] = meta?.keywords ?? []
    const nodeLabel = node.label.toLowerCase()

    const allTerms = [...keywords, nodeLabel]

    if (allTerms.some(kw => factValue.includes(kw) || factKey.includes(kw))) {
      // For document_state: only complete if the value signals completion
      if (fact.type === 'document_state') {
        const completionSignals = ['signed', 'approved', 'received', 'completed', 'done', 'podepsán', 'schválen', 'přijat']
        if (!completionSignals.some(s => factValue.includes(s))) continue
      }
      return node
    }
  }

  return null
}

// ─── LLM call for novel edges ─────────────────────────────────────────────────

async function proposeEdgesForUnmatchedFacts(
  dealId: string,
  unmatchedFacts: HardFact[],
  allNodes: DealGraphNode[]
): Promise<void> {
  if (unmatchedFacts.length === 0 || allNodes.length === 0) return

  const nodeList = allNodes
    .map((n, i) => `  ${i}: "${n.label}" [${n.node_type}, ${n.status}]`)
    .join('\n')

  const factList = unmatchedFacts
    .map(f => `  ${f.type}.${f.key} = "${f.value}"`)
    .join('\n')

  const prompt = `A deal's dependency graph has these nodes:
${nodeList}

New facts arrived that don't match any existing node:
${factList}

Do any of these facts imply a new dependency between existing nodes that isn't already present?
For example: "financing_approval_date" arriving might mean "Financing approved" should now depend on a new deadline node.

Only propose edges that are genuinely implied by the facts. If nothing is implied, return an empty array.

Respond with ONLY valid JSON:
{
  "proposed_edges": [
    { "from_index": 0, "to_index": 1, "edge_type": "depends_on", "reason": "brief explanation" }
  ]
}`

  let raw: string
  try {
    raw = await runAITask('graph_proposal', prompt)
  } catch (err) {
    console.warn(`[GraphUpdater] graph_proposal LLM call failed: ${err}`)
    return
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return

  let parsed: { proposed_edges?: Array<{ from_index: number; to_index: number; edge_type: string }> }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return
  }

  for (const edge of parsed.proposed_edges ?? []) {
    const from = allNodes[edge.from_index]
    const to   = allNodes[edge.to_index]
    if (!from || !to) continue

    await createEdge({
      deal_id: dealId,
      from_node_id: from.id,
      to_node_id: to.id,
      edge_type: (edge.edge_type as 'depends_on' | 'blocks' | 'suggests') || 'suggests',
      source: 'ai',
    }).catch(err => console.warn(`[GraphUpdater] Failed to create proposed edge: ${err}`))
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Update the deal's dependency graph based on new hard facts.
 *
 *   - If the deal has no nodes yet: seed from template first.
 *   - Match each fact to a pending node by keyword; flip to completed.
 *   - Facts that match no node: one LLM call to propose novel edges.
 *
 * @param userId     Owner (needed for seeding)
 * @param dealId     Target deal
 * @param hardFacts  Hard facts from the current extraction run
 */
export async function updateGraph(
  userId: string,
  dealId: string,
  hardFacts: HardFact[]
): Promise<void> {
  // Load current DAG
  let dag = await getDAG(dealId)

  // Seed if empty
  if (dag.nodes.length === 0) {
    await seedGraph(userId, dealId)
    dag = await getDAG(dealId)
  }

  if (hardFacts.length === 0) return

  const pendingNodes = dag.nodes.filter(n => n.status === 'pending')
  const unmatchedFacts: HardFact[] = []

  // Deterministic matching
  for (const fact of hardFacts) {
    const match = matchFactToNode(fact, pendingNodes)
    if (match) {
      await updateNodeStatus(match.id, 'completed').catch(err =>
        console.warn(`[GraphUpdater] Failed to complete node "${match.label}": ${err}`)
      )
      // Remove from pendingNodes to prevent double-completion
      const idx = pendingNodes.indexOf(match)
      if (idx !== -1) pendingNodes.splice(idx, 1)
    } else {
      unmatchedFacts.push(fact)
    }
  }

  // LLM call only for truly unmatched facts — rare
  if (unmatchedFacts.length > 0) {
    await proposeEdgesForUnmatchedFacts(dealId, unmatchedFacts, dag.nodes)
  }
}
