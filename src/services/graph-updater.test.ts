import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateGraph } from './graph-updater'
import type { HardFact } from './fact-extractor'
import type { DealGraphNode } from '@/lib/supabase/types'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

vi.mock('@/lib/db/deal-graph', () => ({
  getDAG: vi.fn(),
  createNode: vi.fn(),
  updateNodeStatus: vi.fn().mockResolvedValue(undefined),
  createEdge: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/db/deals', () => ({
  getDealById: vi.fn(),
}))

import { runAITask } from '@/lib/ai/runner'
import { getDAG, createNode, updateNodeStatus, createEdge } from '@/lib/db/deal-graph'
import { getDealById } from '@/lib/db/deals'

const PENDING_NODE = (id: string, label: string, keywords: string[]): DealGraphNode => ({
  id,
  deal_id: 'deal-1',
  user_id: 'user-1',
  cp_id: null,
  label,
  node_type: 'milestone',
  status: 'pending',
  deadline: null,
  metadata: { keywords },
  completed_at: null,
  created_at: new Date().toISOString(),
})

const EMPTY_DAG = { nodes: [], edges: [] }

const SEEDED_DAG = {
  nodes: [
    PENDING_NODE('node-1', 'Offer received', ['offer', 'nabídka']),
    PENDING_NODE('node-2', 'Purchase contract', ['contract', 'smlouva']),
  ],
  edges: [],
}

beforeEach(() => {
  vi.mocked(getDAG).mockReset()
  vi.mocked(createNode).mockReset()
  vi.mocked(updateNodeStatus).mockReset().mockResolvedValue(undefined)
  vi.mocked(createEdge).mockReset().mockResolvedValue({} as never)
  vi.mocked(getDealById).mockReset()
  // Default: return empty proposals so tests that don't expect LLM don't crash
  vi.mocked(runAITask).mockReset().mockResolvedValue('{"proposed_edges":[]}')
})

describe('updateGraph — seeding', () => {
  it('seeds the graph from template when DAG is empty', async () => {
    vi.mocked(getDealById).mockResolvedValue({
      id: 'deal-1',
      deal_type: 'purchase',
      category: 'business',
    } as never)
    vi.mocked(getDAG)
      .mockResolvedValueOnce(EMPTY_DAG)
      .mockResolvedValueOnce(SEEDED_DAG)
    vi.mocked(createNode).mockImplementation(async (n) => ({ ...n, id: 'new-node', created_at: '' } as never))

    await updateGraph('user-1', 'deal-1', [])

    expect(createNode).toHaveBeenCalled()
  })

  it('does not seed again when nodes already exist', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)

    await updateGraph('user-1', 'deal-1', [])

    expect(getDealById).not.toHaveBeenCalled()
    expect(createNode).not.toHaveBeenCalled()
  })
})

describe('updateGraph — fact matching', () => {
  it('completes a node when a fact keyword matches', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)

    const facts: HardFact[] = [
      { type: 'deal_stage', key: 'stage', value: 'offer received', source_message_id: 'msg-1', confidence: 0.9 },
    ]

    await updateGraph('user-1', 'deal-1', facts)

    expect(updateNodeStatus).toHaveBeenCalledWith('node-1', 'completed')
  })

  it('does not complete a node twice for the same fact', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)

    const facts: HardFact[] = [
      { type: 'deal_stage', key: 'stage', value: 'offer received', source_message_id: 'msg-1', confidence: 0.9 },
      { type: 'deal_stage', key: 'stage2', value: 'offer accepted', source_message_id: 'msg-2', confidence: 0.85 },
    ]

    await updateGraph('user-1', 'deal-1', facts)

    // node-1 matched first fact; second fact should also match node-1 but it's removed from pending
    expect(updateNodeStatus).toHaveBeenCalledTimes(1)
  })

  it('does not complete a document node on a non-completion value', async () => {
    const docNode = PENDING_NODE('node-doc', 'Purchase contract', ['contract', 'smlouva'])
    docNode.node_type = 'document'
    vi.mocked(getDAG).mockResolvedValue({ nodes: [docNode], edges: [] })

    const facts: HardFact[] = [
      { type: 'document_state', key: 'contract', value: 'contract sent for review', source_message_id: 'msg-1', confidence: 0.8 },
    ]

    await updateGraph('user-1', 'deal-1', facts)
    expect(updateNodeStatus).not.toHaveBeenCalled()
  })

  it('completes a document node on a completion signal', async () => {
    const docNode = PENDING_NODE('node-doc', 'Purchase contract', ['contract', 'smlouva'])
    docNode.node_type = 'document'
    vi.mocked(getDAG).mockResolvedValue({ nodes: [docNode], edges: [] })

    const facts: HardFact[] = [
      { type: 'document_state', key: 'contract', value: 'contract signed', source_message_id: 'msg-1', confidence: 0.95 },
    ]

    await updateGraph('user-1', 'deal-1', facts)
    expect(updateNodeStatus).toHaveBeenCalledWith('node-doc', 'completed')
  })
})

describe('updateGraph — unmatched facts → LLM', () => {
  it('calls graph_proposal LLM when facts have no matching node', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)
    vi.mocked(runAITask).mockResolvedValue('{"proposed_edges":[]}')

    const facts: HardFact[] = [
      { type: 'deadline', key: 'closing_date', value: '2026-05-30', source_message_id: 'msg-1', confidence: 0.9 },
    ]

    await updateGraph('user-1', 'deal-1', facts)
    expect(runAITask).toHaveBeenCalledWith('graph_proposal', expect.any(String))
  })

  it('does not call LLM when all facts match existing nodes', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)

    const facts: HardFact[] = [
      { type: 'deal_stage', key: 'stage', value: 'offer nabídka', source_message_id: 'msg-1', confidence: 0.9 },
    ]

    await updateGraph('user-1', 'deal-1', facts)
    expect(runAITask).not.toHaveBeenCalled()
  })

  it('creates proposed edges from LLM response', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)
    vi.mocked(runAITask).mockResolvedValue(
      '{"proposed_edges":[{"from_index":0,"to_index":1,"edge_type":"depends_on","reason":"test"}]}'
    )

    const facts: HardFact[] = [
      { type: 'deadline', key: 'closing_date', value: '2026-05-30', source_message_id: 'msg-1', confidence: 0.9 },
    ]

    await updateGraph('user-1', 'deal-1', facts)
    expect(createEdge).toHaveBeenCalledWith(
      expect.objectContaining({ from_node_id: 'node-1', to_node_id: 'node-2', edge_type: 'depends_on', source: 'ai' })
    )
  })

  it('fails open when LLM returns unparseable response', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)
    vi.mocked(runAITask).mockResolvedValue('not json at all')

    const facts: HardFact[] = [
      { type: 'deadline', key: 'closing_date', value: '2026-05-30', source_message_id: 'msg-1', confidence: 0.9 },
    ]

    await expect(updateGraph('user-1', 'deal-1', facts)).resolves.toBeUndefined()
    expect(createEdge).not.toHaveBeenCalled()
  })

  it('fails open when LLM call throws', async () => {
    vi.mocked(getDAG).mockResolvedValue(SEEDED_DAG)
    vi.mocked(runAITask).mockRejectedValue(new Error('503'))

    const facts: HardFact[] = [
      { type: 'deadline', key: 'closing_date', value: '2026-05-30', source_message_id: 'msg-1', confidence: 0.9 },
    ]

    await expect(updateGraph('user-1', 'deal-1', facts)).resolves.toBeUndefined()
  })
})
