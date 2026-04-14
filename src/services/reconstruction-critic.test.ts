import { describe, it, expect, vi, beforeEach } from 'vitest'
import { critiqueExtraction } from './reconstruction-critic'
import type { ExtractionOutput } from './fact-extractor'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

import { runAITask } from '@/lib/ai/runner'

const CLEAN_EXTRACTION: ExtractionOutput = {
  scratchpad: 'Everything was captured.',
  hard_facts: [
    { type: 'price', key: 'asking_price', value: '4 500 000 Kč', source_message_id: 'msg-1', confidence: 0.95 },
    { type: 'address', key: 'property_address', value: 'Dykova 17', source_message_id: 'msg-1', confidence: 0.9 },
  ],
  soft_observations: [
    { topic: 'buyer_interest', content: 'Kupující má zájem', confidence: 0.85, source_message_id: 'msg-1' },
  ],
}

const MESSAGES = [
  'Mám zájem o byt na Dykova 17 za 4 500 000 Kč. Podepíšeme smlouvu 30. dubna.',
]

beforeEach(() => {
  vi.mocked(runAITask).mockReset()
})

describe('critiqueExtraction', () => {
  it('returns complete=true and empty gaps for a clean extraction', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"gaps":[],"is_complete":true}')
    const result = await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)

    expect(result.is_complete).toBe(true)
    expect(result.gaps).toHaveLength(0)
  })

  it('returns gaps when extraction is missing information', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"gaps":["Missing contract signing deadline of April 30"],"is_complete":false}')
    const result = await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)

    expect(result.is_complete).toBe(false)
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toContain('April 30')
  })

  it('calls reconstruction_critic stage', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"gaps":[],"is_complete":true}')
    await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)
    expect(runAITask).toHaveBeenCalledWith('reconstruction_critic', expect.any(String))
  })

  it('returns complete=true for empty message array without calling LLM', async () => {
    const result = await critiqueExtraction([], CLEAN_EXTRACTION)
    expect(result.is_complete).toBe(true)
    expect(runAITask).not.toHaveBeenCalled()
  })

  it('fails open on LLM error — returns complete=true so pipeline is not blocked', async () => {
    vi.mocked(runAITask).mockRejectedValue(new Error('503'))
    const result = await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)
    expect(result.is_complete).toBe(true)
    expect(result.gaps).toHaveLength(0)
  })

  it('fails open on unparseable response', async () => {
    vi.mocked(runAITask).mockResolvedValue('not json')
    const result = await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)
    expect(result.is_complete).toBe(true)
  })

  it('includes facts in prompt so critic can compare', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"gaps":[],"is_complete":true}')
    await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)
    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    expect(prompt).toContain('asking_price')
    expect(prompt).toContain('4 500 000 Kč')
  })

  it('filters out non-string gaps', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"gaps":[42, "real gap", null],"is_complete":false}')
    const result = await critiqueExtraction(MESSAGES, CLEAN_EXTRACTION)
    expect(result.gaps).toEqual(['real gap'])
  })
})
