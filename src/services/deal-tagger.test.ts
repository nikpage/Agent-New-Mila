import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tagMessageToDeal } from './deal-tagger'
import type { DealTimelineEntry, Deal } from '@/lib/supabase/types'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

vi.mock('@/lib/db/deals', () => ({
  findDealByExternalThread: vi.fn().mockResolvedValue(null),
  getActiveDealsForCP: vi.fn().mockResolvedValue([]),
  createDeal: vi.fn(),
  updateDeal: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/db/messages', () => ({
  getMessageById: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({ error: null })),
      })),
    })),
  })),
}))

import { runAITask } from '@/lib/ai/runner'
import { findDealByExternalThread, getActiveDealsForCP, createDeal, updateDeal } from '@/lib/db/deals'
import { getMessageById } from '@/lib/db/messages'

const ENTRY = (overrides?: Partial<DealTimelineEntry>): DealTimelineEntry => ({
  id: 'entry-1',
  user_id: 'user-1',
  cp_id: 'cp-1',
  conversation_id: null,
  parent_id: null,
  event_type: 'email',
  direction: 'in',
  occurred_at: '2026-04-14T10:00:00Z',
  ingested_at: '2026-04-14T10:01:00Z',
  content: 'Mám zájem o byt za 4.5M Kč.',
  message_id: 'msg-1',
  metadata: null,
  deal_id: null,
  temporal_data: null,
  is_emergency: false,
  ...overrides,
})

const DEAL = (id: string, title: string): Deal => ({
  id,
  user_id: 'user-1',
  title,
  status: 'active',
  category: 'business',
  deal_type: 'purchase',
  user_role: 'seller',
  parent_deal_id: null,
  potential_merge_with: null,
  anomaly_boost: 0,
  last_processed_at: null,
  created_at: '2026-01-01T00:00:00Z',
  last_activity_at: '2026-04-13T10:00:00Z',
})

beforeEach(() => {
  vi.mocked(runAITask).mockReset()
  vi.mocked(findDealByExternalThread).mockReset().mockResolvedValue(null)
  vi.mocked(getActiveDealsForCP).mockReset().mockResolvedValue([])
  vi.mocked(createDeal).mockReset().mockResolvedValue(DEAL('new-deal-1', 'Mám zájem o byt za 4.5M Kč.'))
  vi.mocked(updateDeal).mockReset().mockResolvedValue({} as never)
  vi.mocked(getMessageById).mockReset().mockResolvedValue(null)
})

describe('tagMessageToDeal — external thread fast path', () => {
  it('returns existing deal when external thread matches', async () => {
    const existingDeal = DEAL('deal-existing', 'Byt Praha')
    vi.mocked(getMessageById).mockResolvedValue({
      id: 'msg-1',
      external_thread_id: 'thread-abc',
    } as never)
    vi.mocked(findDealByExternalThread).mockResolvedValue(existingDeal)

    const result = await tagMessageToDeal(ENTRY(), 'user-1')
    expect(result.id).toBe('deal-existing')
    expect(createDeal).not.toHaveBeenCalled()
  })
})

describe('tagMessageToDeal — CP deal count', () => {
  it('creates a new deal when CP has no active deals', async () => {
    vi.mocked(getActiveDealsForCP).mockResolvedValue([])

    const result = await tagMessageToDeal(ENTRY(), 'user-1')
    expect(createDeal).toHaveBeenCalledOnce()
    expect(result.id).toBe('new-deal-1')
  })

  it('assigns to the single existing deal when CP has exactly one', async () => {
    const deal = DEAL('deal-solo', 'Prodej domu')
    vi.mocked(getActiveDealsForCP).mockResolvedValue([deal])

    const result = await tagMessageToDeal(ENTRY(), 'user-1')
    expect(result.id).toBe('deal-solo')
    expect(createDeal).not.toHaveBeenCalled()
  })

  it('touches deal last_activity_at when assigning to existing deal', async () => {
    const deal = DEAL('deal-solo', 'Prodej domu')
    vi.mocked(getActiveDealsForCP).mockResolvedValue([deal])

    await tagMessageToDeal(ENTRY(), 'user-1')
    expect(updateDeal).toHaveBeenCalledWith('deal-solo', expect.objectContaining({ last_activity_at: expect.any(String) }))
  })
})

describe('tagMessageToDeal — AI assignment', () => {
  it('returns AI-matched deal when multiple deals exist', async () => {
    const deal1 = DEAL('deal-1', 'Byt Praha')
    const deal2 = DEAL('deal-2', 'Dům Brno')
    vi.mocked(getActiveDealsForCP).mockResolvedValue([deal1, deal2])
    vi.mocked(runAITask).mockResolvedValue('deal-1')

    const result = await tagMessageToDeal(ENTRY(), 'user-1')
    expect(result.id).toBe('deal-1')
  })

  it('creates a new deal when AI returns NEW', async () => {
    const deal1 = DEAL('deal-1', 'Byt Praha')
    const deal2 = DEAL('deal-2', 'Dům Brno')
    vi.mocked(getActiveDealsForCP).mockResolvedValue([deal1, deal2])
    vi.mocked(runAITask).mockResolvedValue('NEW')

    await tagMessageToDeal(ENTRY(), 'user-1')
    expect(createDeal).toHaveBeenCalledOnce()
  })

  it('creates a new deal when AI call fails', async () => {
    const deal1 = DEAL('deal-1', 'Byt Praha')
    const deal2 = DEAL('deal-2', 'Dům Brno')
    vi.mocked(getActiveDealsForCP).mockResolvedValue([deal1, deal2])
    vi.mocked(runAITask).mockRejectedValue(new Error('503'))

    await tagMessageToDeal(ENTRY(), 'user-1')
    expect(createDeal).toHaveBeenCalledOnce()
  })

  it('uses threading stage for AI call', async () => {
    const deal1 = DEAL('deal-1', 'Byt Praha')
    const deal2 = DEAL('deal-2', 'Dům Brno')
    vi.mocked(getActiveDealsForCP).mockResolvedValue([deal1, deal2])
    vi.mocked(runAITask).mockResolvedValue('NEW')

    await tagMessageToDeal(ENTRY(), 'user-1')
    expect(runAITask).toHaveBeenCalledWith('threading', expect.any(String))
  })
})

describe('tagMessageToDeal — no CP', () => {
  it('creates a new deal when entry has no cp_id', async () => {
    await tagMessageToDeal(ENTRY({ cp_id: null as never }), 'user-1')
    expect(createDeal).toHaveBeenCalledOnce()
    expect(getActiveDealsForCP).not.toHaveBeenCalled()
  })
})

describe('tagMessageToDeal — deal title', () => {
  it('truncates long content for deal title', async () => {
    vi.mocked(getActiveDealsForCP).mockResolvedValue([])
    const longContent = 'x'.repeat(200)

    await tagMessageToDeal(ENTRY({ content: longContent }), 'user-1')
    const calledWith = vi.mocked(createDeal).mock.calls[0][0]
    expect(calledWith.title.length).toBeLessThanOrEqual(100)
  })

  it('uses fallback title when content is null', async () => {
    vi.mocked(getActiveDealsForCP).mockResolvedValue([])

    await tagMessageToDeal(ENTRY({ content: null }), 'user-1')
    const calledWith = vi.mocked(createDeal).mock.calls[0][0]
    expect(typeof calledWith.title).toBe('string')
    expect(calledWith.title.length).toBeGreaterThan(0)
  })
})
