import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectAnomaly } from './anomaly-detector'
import type { UserSettings } from '@/lib/supabase/types'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

import { runAITask } from '@/lib/ai/runner'

const SETTINGS = { ai_language: 'Czech' } as UserSettings
const CONTEXT = {
  deal_id: 'deal-1',
  deal_title: 'Byt Praha',
  entity_map_snapshot: { 'price.asking_price': '5 000 000 Kč' },
}

beforeEach(() => {
  vi.mocked(runAITask).mockReset()
})

describe('detectAnomaly', () => {
  it('returns is_anomaly=true when LLM detects anomaly', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_anomaly":true,"reason":"commission at risk"}')
    const result = await detectAnomaly('Zájemce jednal s jiným makléřem.', CONTEXT, SETTINGS)
    expect(result.is_anomaly).toBe(true)
    expect(result.reason).toBe('commission at risk')
  })

  it('returns is_anomaly=false for normal messages', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_anomaly":false,"reason":"routine update"}')
    const result = await detectAnomaly('Zájem o prohlídku příští týden.', CONTEXT, SETTINGS)
    expect(result.is_anomaly).toBe(false)
  })

  it('calls anomaly stage', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_anomaly":false,"reason":"ok"}')
    await detectAnomaly('hello', CONTEXT, SETTINGS)
    expect(runAITask).toHaveBeenCalledWith('anomaly', expect.any(String))
  })

  it('fails open (non-anomaly) when LLM throws', async () => {
    vi.mocked(runAITask).mockRejectedValue(new Error('503'))
    const result = await detectAnomaly('Urgentní zpráva!', CONTEXT, SETTINGS)
    expect(result.is_anomaly).toBe(false)
    expect(result.reason).toBe('llm_unavailable')
  })

  it('fails open on unparseable JSON', async () => {
    vi.mocked(runAITask).mockResolvedValue('not json')
    const result = await detectAnomaly('Urgentní zpráva!', CONTEXT, SETTINGS)
    expect(result.is_anomaly).toBe(false)
    expect(result.reason).toBe('parse_failed')
  })

  it('returns non-anomaly for empty text without calling LLM', async () => {
    const result = await detectAnomaly('   ', CONTEXT, SETTINGS)
    expect(result.is_anomaly).toBe(false)
    expect(runAITask).not.toHaveBeenCalled()
  })

  it('includes entity map in prompt', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_anomaly":false,"reason":"ok"}')
    await detectAnomaly('hello', CONTEXT, SETTINGS)
    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    expect(prompt).toContain('asking_price')
    expect(prompt).toContain('5 000 000 Kč')
  })
})
