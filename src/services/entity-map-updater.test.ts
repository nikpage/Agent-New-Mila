import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateEntityMap } from './entity-map-updater'
import type { HardFact } from './fact-extractor'

vi.mock('@/lib/db/entity-map', () => ({
  upsertEntity: vi.fn().mockResolvedValue({}),
}))

import { upsertEntity } from '@/lib/db/entity-map'

const FACTS: HardFact[] = [
  { type: 'price', key: 'asking_price', value: '4 500 000 Kč', source_message_id: 'msg-1', confidence: 0.95 },
  { type: 'address', key: 'property_address', value: 'Dykova 17', source_message_id: 'msg-1', confidence: 0.9 },
]

beforeEach(() => {
  vi.mocked(upsertEntity).mockReset().mockResolvedValue({} as never)
})

describe('updateEntityMap', () => {
  it('calls upsertEntity for each hard fact', async () => {
    await updateEntityMap('user-1', 'deal-1', FACTS)
    expect(upsertEntity).toHaveBeenCalledTimes(2)
  })

  it('passes correct arguments to upsertEntity', async () => {
    await updateEntityMap('user-1', 'deal-1', FACTS)
    expect(upsertEntity).toHaveBeenCalledWith(
      'user-1', 'deal-1', 'price', 'asking_price', '4 500 000 Kč', 'msg-1', 0.95
    )
    expect(upsertEntity).toHaveBeenCalledWith(
      'user-1', 'deal-1', 'address', 'property_address', 'Dykova 17', 'msg-1', 0.9
    )
  })

  it('does nothing when facts array is empty', async () => {
    await updateEntityMap('user-1', 'deal-1', [])
    expect(upsertEntity).not.toHaveBeenCalled()
  })

  it('continues when one upsert fails', async () => {
    vi.mocked(upsertEntity)
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({} as never)

    await expect(updateEntityMap('user-1', 'deal-1', FACTS)).resolves.toBeUndefined()
    expect(upsertEntity).toHaveBeenCalledTimes(2)
  })

  it('resolves even when all upserts fail', async () => {
    vi.mocked(upsertEntity).mockRejectedValue(new Error('DB down'))
    await expect(updateEntityMap('user-1', 'deal-1', FACTS)).resolves.toBeUndefined()
  })
})
