import { getSupabaseAdmin } from '../supabase/client'
import type { DealGraphNode, DealGraphNodeInsert, DealGraphEdge, DealGraphEdgeInsert } from '../supabase/types'

export interface DealDAG {
  nodes: DealGraphNode[]
  edges: DealGraphEdge[]
}

export async function createNode(node: DealGraphNodeInsert): Promise<DealGraphNode> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_graph_nodes')
    .insert({ ...node, created_at: new Date().toISOString() })
    .select()
    .single()

  if (error) throw new Error(`Failed to create graph node: ${error.message}`)
  return data
}

export async function updateNodeStatus(
  nodeId: string,
  status: 'pending' | 'completed' | 'blocked' | 'skipped',
  completedAt?: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('deal_graph_nodes')
    .update({
      status,
      completed_at: status === 'completed' ? (completedAt ?? new Date().toISOString()) : null,
    })
    .eq('id', nodeId)

  if (error) throw new Error(`Failed to update node status: ${error.message}`)
}

export async function getNodesForDeal(
  dealId: string,
  status?: string
): Promise<DealGraphNode[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('deal_graph_nodes')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: true })

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(`Failed to get graph nodes: ${error.message}`)
  return data || []
}

/**
 * Returns pending nodes whose upstream dependencies are all completed.
 * These are the nodes currently unblocked and actionable.
 */
export async function getBlockingNodes(dealId: string): Promise<DealGraphNode[]> {
  const supabase = getSupabaseAdmin()

  // Get all nodes and edges for this deal
  const { nodes, edges } = await getDAG(dealId)

  const completedIds = new Set(
    nodes.filter(n => n.status === 'completed').map(n => n.id)
  )

  // A node is "blocking" if it's pending and all its upstream dependencies are complete
  const blocking: DealGraphNode[] = []
  for (const node of nodes) {
    if (node.status !== 'pending') continue

    const upstreamEdges = edges.filter(e => e.to_node_id === node.id && e.edge_type === 'depends_on')
    const allUpstreamDone = upstreamEdges.every(e => completedIds.has(e.from_node_id))

    if (allUpstreamDone) blocking.push(node)
  }

  return blocking
}

export async function createEdge(edge: DealGraphEdgeInsert): Promise<DealGraphEdge> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_graph_edges')
    .upsert(
      { ...edge, created_at: new Date().toISOString() },
      { onConflict: 'from_node_id,to_node_id,edge_type' }
    )
    .select()
    .single()

  if (error) throw new Error(`Failed to create graph edge: ${error.message}`)
  return data
}

export async function getEdgesForDeal(dealId: string): Promise<DealGraphEdge[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_graph_edges')
    .select('*')
    .eq('deal_id', dealId)

  if (error) throw new Error(`Failed to get graph edges: ${error.message}`)
  return data || []
}

export async function removeEdge(edgeId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('deal_graph_edges')
    .delete()
    .eq('id', edgeId)

  if (error) throw new Error(`Failed to remove graph edge: ${error.message}`)
}

export async function getDAG(dealId: string): Promise<DealDAG> {
  const supabase = getSupabaseAdmin()

  const [nodesResult, edgesResult] = await Promise.all([
    supabase.from('deal_graph_nodes').select('*').eq('deal_id', dealId).order('created_at', { ascending: true }),
    supabase.from('deal_graph_edges').select('*').eq('deal_id', dealId),
  ])

  if (nodesResult.error) throw new Error(`Failed to get DAG nodes: ${nodesResult.error.message}`)
  if (edgesResult.error) throw new Error(`Failed to get DAG edges: ${edgesResult.error.message}`)

  return {
    nodes: nodesResult.data || [],
    edges: edgesResult.data || [],
  }
}
