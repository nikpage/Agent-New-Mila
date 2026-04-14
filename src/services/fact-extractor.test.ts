import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractFactsAndBeliefs, type DealMessage, type DealContext } from './fact-extractor'
import { DEFAULT_USER_SETTINGS } from '@/lib/supabase/types'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

import { runAITask } from '@/lib/ai/runner'

const EMPTY_TEMPORAL = { expressions: [], needs_human_review: false }

const DEAL_CTX: DealContext = {
  deal_id: 'deal-1',
  deal_title: 'Prodej bytu Dykova 17',
  deal_type: 'sale',
}

const MESSAGES: DealMessage[] = [
  {
    id: 'msg-1',
    direction: 'in',
    content: 'Dobrý den, mám zájem o byt na Dykova 17. Cena je 4 500 000 Kč, je to stále aktuální?',
    occurred_at: '2026-04-14T09:00:00Z',
    channel: 'email',
    cp_name: 'Jan Novotný',
  },
  {
    id: 'msg-2',
    direction: 'out',
    content: 'Dobrý den, ano, byt je stále v nabídce za 4 500 000 Kč. Mohu vám zařídit prohlídku.',
    occurred_at: '2026-04-14T10:30:00Z',
    channel: 'email',
  },
]

const MOCK_EXTRACTION_RESPONSE = `SCRATCHPAD:
The inbound message asks about price availability. The outbound confirms the price at 4 500 000 Kč. A viewing is offered.

JSON:
{
  "hard_facts": [
    {
      "type": "price",
      "key": "asking_price",
      "value": "4 500 000 Kč",
      "source_index": 0,
      "confidence": 0.95
    },
    {
      "type": "address",
      "key": "property_address",
      "value": "Dykova 17",
      "source_index": 0,
      "confidence": 0.9
    }
  ],
  "soft_observations": [
    {
      "topic": "buyer_interest",
      "content": "Kupující projevil zájem o byt a ptá se na dostupnost",
      "confidence": 0.9,
      "source_index": 0
    }
  ]
}`

beforeEach(() => {
  vi.mocked(runAITask).mockReset()
})

describe('extractFactsAndBeliefs', () => {
  it('returns empty output for empty message array', async () => {
    const result = await extractFactsAndBeliefs([], EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)
    expect(result.hard_facts).toHaveLength(0)
    expect(result.soft_observations).toHaveLength(0)
    expect(runAITask).not.toHaveBeenCalled()
  })

  it('calls extraction stage', async () => {
    vi.mocked(runAITask).mockResolvedValue(MOCK_EXTRACTION_RESPONSE)
    await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)
    expect(runAITask).toHaveBeenCalledWith('extraction', expect.any(String))
  })

  it('parses hard facts correctly', async () => {
    vi.mocked(runAITask).mockResolvedValue(MOCK_EXTRACTION_RESPONSE)
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)

    expect(result.hard_facts).toHaveLength(2)
    expect(result.hard_facts[0].type).toBe('price')
    expect(result.hard_facts[0].key).toBe('asking_price')
    expect(result.hard_facts[0].value).toBe('4 500 000 Kč')
    expect(result.hard_facts[0].source_message_id).toBe('msg-1')
    expect(result.hard_facts[0].confidence).toBe(0.95)
  })

  it('maps source_index 1 to second message id', async () => {
    const response = `SCRATCHPAD: ...\nJSON:\n{"hard_facts":[{"type":"commitment","key":"viewing_offered","value":"Nabídka prohlídky","source_index":1,"confidence":0.85}],"soft_observations":[]}`
    vi.mocked(runAITask).mockResolvedValue(response)
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)

    expect(result.hard_facts[0].source_message_id).toBe('msg-2')
  })

  it('parses soft observations correctly', async () => {
    vi.mocked(runAITask).mockResolvedValue(MOCK_EXTRACTION_RESPONSE)
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)

    expect(result.soft_observations).toHaveLength(1)
    expect(result.soft_observations[0].topic).toBe('buyer_interest')
    expect(result.soft_observations[0].source_message_id).toBe('msg-1')
  })

  it('captures scratchpad text', async () => {
    vi.mocked(runAITask).mockResolvedValue(MOCK_EXTRACTION_RESPONSE)
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)

    expect(result.scratchpad).toContain('inbound message asks about price')
  })

  it('includes resolved timestamps in prompt when present', async () => {
    vi.mocked(runAITask).mockResolvedValue(MOCK_EXTRACTION_RESPONSE)
    const temporal = {
      expressions: [{ original_text: 'zítra', generated_code: 'tomorrow(anchor)', resolved_date: '2026-04-15T09:00:00.000Z', execution_error: null, confidence: 0.95 }],
      needs_human_review: false,
    }
    await extractFactsAndBeliefs(MESSAGES, temporal, DEAL_CTX, DEFAULT_USER_SETTINGS)
    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    expect(prompt).toContain('zítra')
    expect(prompt).toContain('2026-04-15')
  })

  it('injects gap instructions when gaps provided', async () => {
    vi.mocked(runAITask).mockResolvedValue(MOCK_EXTRACTION_RESPONSE)
    await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS, ['Missing deposit amount'])
    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    expect(prompt).toContain('Missing deposit amount')
  })

  it('returns empty output on LLM failure without throwing', async () => {
    vi.mocked(runAITask).mockRejectedValue(new Error('API error'))
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)
    expect(result.hard_facts).toHaveLength(0)
    expect(result.soft_observations).toHaveLength(0)
  })

  it('returns empty output on unparseable JSON', async () => {
    vi.mocked(runAITask).mockResolvedValue('SCRATCHPAD: ...\nJSON:\nnot valid json at all')
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)
    expect(result.hard_facts).toHaveLength(0)
  })

  it('clamps confidence to 0–1', async () => {
    const response = `SCRATCHPAD: ...\nJSON:\n{"hard_facts":[{"type":"price","key":"asking_price","value":"5M","source_index":0,"confidence":1.5}],"soft_observations":[]}`
    vi.mocked(runAITask).mockResolvedValue(response)
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)
    expect(result.hard_facts[0].confidence).toBe(1.0)
  })

  it('skips facts with out-of-range source_index', async () => {
    const response = `SCRATCHPAD: ...\nJSON:\n{"hard_facts":[{"type":"price","key":"asking_price","value":"5M","source_index":99,"confidence":0.9}],"soft_observations":[]}`
    vi.mocked(runAITask).mockResolvedValue(response)
    const result = await extractFactsAndBeliefs(MESSAGES, EMPTY_TEMPORAL, DEAL_CTX, DEFAULT_USER_SETTINGS)
    expect(result.hard_facts).toHaveLength(0)
  })
})
