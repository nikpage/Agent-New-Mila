import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateCards, deriveCardType } from './card-generator'
import type { ScoredTask } from './scoring-engine'
import type { UserSettings } from '@/lib/supabase/types'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))
vi.mock('@/lib/db/journal', () => ({
  getCurrentBeliefs: vi.fn().mockResolvedValue([]),
}))

import { runAITask } from '@/lib/ai/runner'
import { getCurrentBeliefs } from '@/lib/db/journal'

const SETTINGS: UserSettings = { ai_language: 'Czech' } as UserSettings

const TASK = (overrides?: Partial<ScoredTask>): ScoredTask => ({
  nodeId: 'node-1',
  dealId: 'deal-1',
  taskType: 'blocking',
  nodeLabel: 'Property viewings',
  deadline: null,
  hoursUntilDue: null,
  slack: null,
  cpId: 'cp-1',
  entityMapSnapshot: {},
  beliefSnapshot: [],
  score: 50,
  scoreBreakdown: {
    dealImportance: 10,
    timePressure: 30,
    graphPressure: 2,
    immovability: 0,
    anomalyBoost: 0,
  },
  ...overrides,
})

const VALID_RESPONSE = JSON.stringify({
  intent_cs: 'Zavolat Novákovi ohledně smlouvy.',
  rationale_cs: 'Smlouva čeká na podpis.',
  draft_skeleton: null,
  placeholders: [],
})

beforeEach(() => {
  vi.mocked(runAITask).mockReset()
  vi.mocked(getCurrentBeliefs).mockReset().mockResolvedValue([])
})

// ─── deriveCardType ────────────────────────────────────────────────────────────

describe('deriveCardType', () => {
  it('lead tasks → REPLY', () => {
    expect(deriveCardType('lead_cooling')).toBe('REPLY')
    expect(deriveCardType('lead_cold')).toBe('REPLY')
    expect(deriveCardType('lead_dead')).toBe('REPLY')
  })

  it('calendar_conflict → SCHEDULE', () => {
    expect(deriveCardType('calendar_conflict')).toBe('SCHEDULE')
  })

  it('graph tasks → TODO', () => {
    expect(deriveCardType('blocking')).toBe('TODO')
    expect(deriveCardType('overdue')).toBe('TODO')
    expect(deriveCardType('due_soon')).toBe('TODO')
    expect(deriveCardType('has_slack')).toBe('TODO')
  })
})

// ─── generateCards ────────────────────────────────────────────────────────────

describe('generateCards — basic', () => {
  it('returns empty array for empty input', async () => {
    const result = await generateCards([], SETTINGS)
    expect(result).toHaveLength(0)
    expect(runAITask).not.toHaveBeenCalled()
  })

  it('generates one card per task', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)
    const result = await generateCards([TASK(), TASK({ dealId: 'deal-2' })], SETTINGS)
    expect(result).toHaveLength(2)
    expect(runAITask).toHaveBeenCalledTimes(2)
  })

  it('sets card_type based on taskType', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)

    const results = await generateCards([
      TASK({ taskType: 'lead_cooling', dealId: 'd1' }),
      TASK({ taskType: 'calendar_conflict', dealId: 'd2' }),
      TASK({ taskType: 'blocking', dealId: 'd3' }),
    ], SETTINGS)

    expect(results.find(r => r.dealId === 'd1')?.card_type).toBe('REPLY')
    expect(results.find(r => r.dealId === 'd2')?.card_type).toBe('SCHEDULE')
    expect(results.find(r => r.dealId === 'd3')?.card_type).toBe('TODO')
  })

  it('passes intent_cs and rationale_cs from LLM', async () => {
    vi.mocked(runAITask).mockResolvedValue(JSON.stringify({
      intent_cs: 'Zavolat klientovi.',
      rationale_cs: 'Čeká na odpověď.',
      draft_skeleton: null,
      placeholders: [],
    }))

    const [card] = await generateCards([TASK()], SETTINGS)
    expect(card.intent_cs).toBe('Zavolat klientovi.')
    expect(card.rationale_cs).toBe('Čeká na odpověď.')
  })

  it('uses drafting stage', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)
    await generateCards([TASK()], SETTINGS)
    expect(runAITask).toHaveBeenCalledWith('drafting', expect.any(String))
  })
})

describe('generateCards — REPLY cards', () => {
  it('includes draft_skeleton for REPLY cards when LLM provides one', async () => {
    vi.mocked(runAITask).mockResolvedValue(JSON.stringify({
      intent_cs: 'Napsat Novákovi.',
      rationale_cs: 'Klient neodpovídal.',
      draft_skeleton: 'Dobrý den, {{ jméno }}, chtěl jsem se zeptat...',
      placeholders: ['jméno'],
    }))

    const [card] = await generateCards([TASK({ taskType: 'lead_cold' })], SETTINGS)
    expect(card.card_type).toBe('REPLY')
    expect(card.draft_skeleton).toContain('{{ jméno }}')
    expect(card.placeholders).toContain('jméno')
  })

  it('draft_skeleton is null for TODO cards even if LLM provides one', async () => {
    vi.mocked(runAITask).mockResolvedValue(JSON.stringify({
      intent_cs: 'Dokončit úkol.',
      rationale_cs: 'Blokuje deal.',
      draft_skeleton: 'This should be ignored.',
      placeholders: [],
    }))

    const [card] = await generateCards([TASK({ taskType: 'blocking' })], SETTINGS)
    expect(card.card_type).toBe('TODO')
    expect(card.draft_skeleton).toBeNull()
  })
})

describe('generateCards — fail open', () => {
  it('uses default text when LLM throws', async () => {
    vi.mocked(runAITask).mockRejectedValue(new Error('503'))
    const [card] = await generateCards([TASK({ taskType: 'blocking' })], SETTINGS)
    expect(card.card_type).toBe('TODO')
    expect(card.intent_cs).toBeTruthy()
    expect(card.rationale_cs).toBeTruthy()
  })

  it('uses default text when LLM returns invalid JSON', async () => {
    vi.mocked(runAITask).mockResolvedValue('not json at all')
    const [card] = await generateCards([TASK({ taskType: 'lead_dead' })], SETTINGS)
    expect(card.card_type).toBe('REPLY')
    expect(card.intent_cs).toBeTruthy()
  })

  it('continues if one task fails — returns other cards', async () => {
    vi.mocked(runAITask)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(VALID_RESPONSE)

    const result = await generateCards([
      TASK({ dealId: 'd1' }),
      TASK({ dealId: 'd2' }),
    ], SETTINGS)

    // Both should return — first via fallback, second via LLM
    expect(result).toHaveLength(2)
  })
})

describe('generateCards — beliefs', () => {
  it('calls getCurrentBeliefs for each task', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)
    await generateCards([TASK({ dealId: 'deal-42' })], SETTINGS)
    expect(getCurrentBeliefs).toHaveBeenCalledWith('deal-42')
  })

  it('includes beliefs in the prompt', async () => {
    vi.mocked(getCurrentBeliefs).mockResolvedValue([
      {
        id: 'j1', user_id: 'u', deal_id: 'deal-1', topic: 'budget',
        content: 'klient má rozpočet 5M', weight: 0.8,
        is_stale: false, created_at: '', updated_at: '',
        scope: 'deal', scope_ref: null, type: 'observation',
        confirm_count: 1, conflict_count: 0, recency_score: null,
        language: 'Czech', expires_at: null,
      },
    ] as never)
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)

    await generateCards([TASK()], SETTINGS)

    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    expect(prompt).toContain('budget')
    expect(prompt).toContain('klient má rozpočet 5M')
  })

  it('uses beliefSnapshot from task if getCurrentBeliefs throws', async () => {
    vi.mocked(getCurrentBeliefs).mockRejectedValue(new Error('DB down'))
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)

    const task = TASK({ beliefSnapshot: ['prior belief from snapshot'] })
    const [card] = await generateCards([task], SETTINGS)
    // Should not throw; card returned normally
    expect(card.beliefSnapshot).toContain('prior belief from snapshot')
  })
})

describe('generateCards — urgency', () => {
  it('overdue → urgency 10', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)
    const [card] = await generateCards([TASK({ taskType: 'overdue' })], SETTINGS)
    expect(card.urgency).toBe(10)
  })

  it('due_soon with < 4h → urgency 9', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)
    const [card] = await generateCards([TASK({ taskType: 'due_soon', hoursUntilDue: 2 })], SETTINGS)
    expect(card.urgency).toBe(9)
  })

  it('lead_cooling → urgency 3', async () => {
    vi.mocked(runAITask).mockResolvedValue(VALID_RESPONSE)
    const [card] = await generateCards([TASK({ taskType: 'lead_cooling' })], SETTINGS)
    expect(card.urgency).toBe(3)
  })
})
