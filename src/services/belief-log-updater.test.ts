import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateBeliefLog } from './belief-log-updater'
import type { SoftObservation } from './fact-extractor'

vi.mock('@/lib/db/journal', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({}),
  findMatchingEntry: vi.fn().mockResolvedValue(null),
  recordConflict: vi.fn().mockResolvedValue({}),
}))

import { createJournalEntry, findMatchingEntry, recordConflict } from '@/lib/db/journal'

const OBSERVATIONS: SoftObservation[] = [
  { topic: 'buyer_interest', content: 'Kupující má zájem o rychlé uzavření', confidence: 0.85, source_message_id: 'msg-1' },
  { topic: 'seller_motivation', content: 'Prodávající potřebuje peníze do konce měsíce', confidence: 0.7, source_message_id: 'msg-2' },
]

beforeEach(() => {
  vi.mocked(createJournalEntry).mockReset().mockResolvedValue({} as never)
  vi.mocked(findMatchingEntry).mockReset().mockResolvedValue(null)
  vi.mocked(recordConflict).mockReset().mockResolvedValue({} as never)
})

describe('updateBeliefLog', () => {
  it('creates a journal entry for each observation', async () => {
    await updateBeliefLog('user-1', 'deal-1', OBSERVATIONS)
    expect(createJournalEntry).toHaveBeenCalledTimes(2)
  })

  it('does nothing when observations array is empty', async () => {
    await updateBeliefLog('user-1', 'deal-1', [])
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('passes correct fields to createJournalEntry', async () => {
    await updateBeliefLog('user-1', 'deal-1', [OBSERVATIONS[0]], 'Czech')
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        deal_id: 'deal-1',
        type: 'observation',
        topic: 'buyer_interest',
        content: 'Kupující má zájem o rychlé uzavření',
        weight: 0.85,
        language: 'Czech',
      })
    )
  })

  it('calls recordConflict when existing entry has different content', async () => {
    vi.mocked(findMatchingEntry).mockResolvedValue({
      id: 'entry-old',
      content: 'Kupující není jistý',
    } as never)

    await updateBeliefLog('user-1', 'deal-1', [OBSERVATIONS[0]])
    expect(recordConflict).toHaveBeenCalledWith('entry-old')
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('does NOT call recordConflict when content is unchanged', async () => {
    vi.mocked(findMatchingEntry).mockResolvedValue({
      id: 'entry-old',
      content: 'Kupující má zájem o rychlé uzavření',
    } as never)

    await updateBeliefLog('user-1', 'deal-1', [OBSERVATIONS[0]])
    expect(recordConflict).not.toHaveBeenCalled()
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('treats whitespace-normalised equal content as unchanged', async () => {
    vi.mocked(findMatchingEntry).mockResolvedValue({
      id: 'entry-old',
      content: 'Kupující  má zájem  o rychlé uzavření',
    } as never)

    await updateBeliefLog('user-1', 'deal-1', [OBSERVATIONS[0]])
    expect(recordConflict).not.toHaveBeenCalled()
  })

  it('continues processing remaining observations when one fails', async () => {
    vi.mocked(createJournalEntry)
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({} as never)

    await expect(updateBeliefLog('user-1', 'deal-1', OBSERVATIONS)).resolves.toBeUndefined()
    expect(createJournalEntry).toHaveBeenCalledTimes(2)
  })

  it('uses Czech as the default language', async () => {
    await updateBeliefLog('user-1', 'deal-1', [OBSERVATIONS[0]])
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'Czech' })
    )
  })
})
