import { describe, it, expect, vi, beforeEach } from 'vitest'
import { walkAllDeals } from './graph-walker'
import type { UserSettings, Deal, DealGraphNode, DealGraphEdge } from '@/lib/supabase/types'
import type { DealDAG } from '@/lib/db/deal-graph'

vi.mock('@/lib/db/deals', () => ({
  getDealsForUser: vi.fn(),
}))
vi.mock('@/lib/db/deal-graph', () => ({
  getDAG: vi.fn(),
  getBlockingNodes: vi.fn(),
}))
vi.mock('@/lib/db/entity-map', () => ({
  getEntitiesForDeal: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/db/journal', () => ({
  getCurrentBeliefs: vi.fn().mockResolvedValue([]),
}))

import { getDealsForUser } from '@/lib/db/deals'
import { getDAG } from '@/lib/db/deal-graph'

const NOW = new Date('2026-04-14T10:00:00Z')
const PAST = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString()
const FUTURE = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString()

const SETTINGS: UserSettings = {
  cooling_threshold_days: 7,
  cold_threshold_days: 14,
  dead_threshold_days: 30,
} as UserSettings

const DEAL = (id: string, overrides?: Partial<Deal>): Deal => ({
  id,
  user_id: 'user-1',
  title: 'Test deal',
  status: 'active',
  category: 'business',
  user_role: 'seller',
  deal_type: 'sale',
  parent_deal_id: null,
  potential_merge_with: null,
  anomaly_boost: 0,
  last_activity_at: PAST(24),
  last_processed_at: null,
  created_at: PAST(720),
  ...overrides,
})

const NODE = (id: string, overrides?: Partial<DealGraphNode>): DealGraphNode => ({
  id,
  deal_id: 'deal-1',
  user_id: 'user-1',
  cp_id: null,
  label: 'Test node',
  node_type: 'milestone',
  status: 'pending',
  completed_at: null,
  deadline: null,
  metadata: {},
  created_at: PAST(48),
  ...overrides,
})

const EMPTY_DAG: DealDAG = { nodes: [], edges: [] }

beforeEach(() => {
  vi.mocked(getDealsForUser).mockReset()
  vi.mocked(getDAG).mockReset().mockResolvedValue(EMPTY_DAG)
})

describe('walkAllDeals — no deals', () => {
  it('returns empty array when user has no active deals', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([])
    const result = await walkAllDeals('user-1', SETTINGS)
    expect(result).toHaveLength(0)
  })
})

describe('walkAllDeals — graph task types', () => {
  it('classifies overdue node (deadline in past)', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({
      nodes: [NODE('node-1', { deadline: PAST(2) })],
      edges: [],
    })

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'overdue')).toBe(true)
    expect(tasks.find(t => t.taskType === 'overdue')?.nodeId).toBe('node-1')
  })

  it('classifies due_soon node (deadline within 24 hours)', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({
      nodes: [NODE('node-1', { deadline: FUTURE(6) })],
      edges: [],
    })

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'due_soon')).toBe(true)
  })

  it('classifies blocking node (no deadline, all upstream complete)', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({
      nodes: [NODE('node-1')],  // pending, no deadline
      edges: [],
    })

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'blocking')).toBe(true)
  })

  it('classifies has_slack node (deadline > 72 hours away)', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({
      nodes: [NODE('node-1', { deadline: FUTURE(96) })],
      edges: [],
    })

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'has_slack')).toBe(true)
    const slackTask = tasks.find(t => t.taskType === 'has_slack')!
    expect(slackTask.slack).toBeGreaterThan(0)
  })

  it('skips completed nodes', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({
      nodes: [
        NODE('node-1', { status: 'completed', deadline: PAST(1) }),
      ],
      edges: [],
    })

    const result = await walkAllDeals('user-1', SETTINGS)
    // Deal has no actionable tasks → not returned
    expect(result).toHaveLength(0)
  })

  it('skips skipped nodes', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({
      nodes: [
        NODE('node-1', { status: 'skipped' }),
      ],
      edges: [],
    })

    const result = await walkAllDeals('user-1', SETTINGS)
    expect(result).toHaveLength(0)
  })
})

describe('walkAllDeals — lead tracking', () => {
  it('detects cooling lead', async () => {
    // 8 days inactive — past cooling threshold (7 days)
    vi.mocked(getDealsForUser).mockResolvedValue([
      DEAL('deal-1', { last_activity_at: PAST(8 * 24) }),
    ])

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'lead_cooling')).toBe(true)
  })

  it('detects cold lead', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([
      DEAL('deal-1', { last_activity_at: PAST(15 * 24) }),
    ])

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'lead_cold')).toBe(true)
  })

  it('detects dead lead', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([
      DEAL('deal-1', { last_activity_at: PAST(31 * 24) }),
    ])

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType === 'lead_dead')).toBe(true)
  })

  it('no lead task for recently active deal', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([
      DEAL('deal-1', { last_activity_at: PAST(1) }),
    ])
    vi.mocked(getDAG).mockResolvedValue({ nodes: [NODE('node-1')], edges: [] })

    const result = await walkAllDeals('user-1', SETTINGS)
    const tasks = result[0]?.tasks ?? []
    expect(tasks.some(t => t.taskType.startsWith('lead_'))).toBe(false)
  })
})

describe('walkAllDeals — fault isolation', () => {
  it('continues when one deal throws', async () => {
    vi.mocked(getDealsForUser).mockResolvedValue([
      DEAL('deal-error'),
      DEAL('deal-ok'),
    ])
    vi.mocked(getDAG)
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce({ nodes: [NODE('node-1')], edges: [] })

    const result = await walkAllDeals('user-1', SETTINGS)
    // deal-ok should still appear
    expect(result.some(r => r.dealId === 'deal-ok')).toBe(true)
  })
})

describe('walkAllDeals — entity map + beliefs', () => {
  it('includes entity map snapshot in tasks', async () => {
    const { getEntitiesForDeal } = await import('@/lib/db/entity-map')
    vi.mocked(getEntitiesForDeal).mockResolvedValue([{
      id: 'e-1', user_id: 'user-1', deal_id: 'deal-1',
      entity_type: 'price', entity_key: 'asking_price',
      entity_value: '4 500 000 Kč',
      source_message_id: null, confidence: 0.9,
      created_at: '', updated_at: '',
    }])
    vi.mocked(getDealsForUser).mockResolvedValue([DEAL('deal-1')])
    vi.mocked(getDAG).mockResolvedValue({ nodes: [NODE('node-1')], edges: [] })

    const result = await walkAllDeals('user-1', SETTINGS)
    const task = result[0]?.tasks[0]
    expect(task?.entityMapSnapshot['price.asking_price']).toBe('4 500 000 Kč')
  })
})
