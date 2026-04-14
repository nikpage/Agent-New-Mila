import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkBypass } from './bypass-filter'
import type { UserSettings } from '@/lib/supabase/types'

vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

import { runAITask } from '@/lib/ai/runner'

const SETTINGS = { ai_language: 'Czech' } as UserSettings

beforeEach(() => {
  vi.mocked(runAITask).mockReset()
})

describe('checkBypass', () => {
  it('returns isEmergency=true when LLM says so', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_emergency":true,"reason":"counterparty walking away now"}')
    const result = await checkBypass('Ruším obchod pokud nedostanu odpověď do 2 hodin.', 'whatsapp', SETTINGS)
    expect(result.isEmergency).toBe(true)
    expect(result.reason).toBe('counterparty walking away now')
  })

  it('returns isEmergency=false for normal messages', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_emergency":false,"reason":"routine follow-up"}')
    const result = await checkBypass('Mohu dostat smlouvu k podpisu příští týden?', 'email', SETTINGS)
    expect(result.isEmergency).toBe(false)
  })

  it('calls bypass stage', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_emergency":false,"reason":"ok"}')
    await checkBypass('hello', 'email', SETTINGS)
    expect(runAITask).toHaveBeenCalledWith('bypass', expect.any(String))
  })

  it('fails open (non-emergency) when LLM throws', async () => {
    vi.mocked(runAITask).mockRejectedValue(new Error('503'))
    const result = await checkBypass('Urgentní zpráva!', 'email', SETTINGS)
    expect(result.isEmergency).toBe(false)
    expect(result.reason).toBe('llm_unavailable')
  })

  it('fails open on unparseable JSON', async () => {
    vi.mocked(runAITask).mockResolvedValue('not json at all')
    const result = await checkBypass('Urgentní zpráva!', 'email', SETTINGS)
    expect(result.isEmergency).toBe(false)
    expect(result.reason).toBe('parse_failed')
  })

  it('fails open on invalid JSON structure', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"unexpected":"field"}')
    const result = await checkBypass('Urgentní zpráva!', 'email', SETTINGS)
    expect(result.isEmergency).toBe(false)
  })

  it('returns isEmergency=false for empty text without calling LLM', async () => {
    const result = await checkBypass('   ', 'email', SETTINGS)
    expect(result.isEmergency).toBe(false)
    expect(runAITask).not.toHaveBeenCalled()
  })

  it('includes channel in prompt', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_emergency":false,"reason":"ok"}')
    await checkBypass('some message', 'whatsapp', SETTINGS)
    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    expect(prompt).toContain('whatsapp')
  })

  it('truncates very long messages in prompt', async () => {
    vi.mocked(runAITask).mockResolvedValue('{"is_emergency":false,"reason":"ok"}')
    const longText = 'x'.repeat(2000)
    await checkBypass(longText, 'email', SETTINGS)
    const prompt = vi.mocked(runAITask).mock.calls[0][1]
    // Should not include more than ~800 chars of the message
    const msgSection = prompt.split('"""')[1]
    expect(msgSection.length).toBeLessThan(850)
  })
})
