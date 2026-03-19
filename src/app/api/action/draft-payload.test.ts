/**
 * Pinning tests: Draft endpoint payload writes
 *
 * RULE: All payload field updates (location, is_online, editedTo) must be
 * batched into a single write using a freshly fetched payload.
 * Sequential writes with stale payload cause race conditions where
 * setting is_online loses location and vice versa.
 *
 * DO NOT modify expected values — if these fail, the payload write logic has regressed.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../../..')

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf-8')
}

describe('Draft endpoint payload writes — route.ts', () => {
  const code = readSrc('src/app/api/action/[id]/draft/route.ts')

  it('batches payload updates into payloadUpdates object', () => {
    expect(code).toContain('payloadUpdates')
  })

  it('is_online is added to payloadUpdates, not written separately', () => {
    expect(code).toContain('payloadUpdates.is_online = isOnline')
  })

  it('editedTo is added to payloadUpdates, not written separately', () => {
    expect(code).toContain('payloadUpdates.editedTo = to')
  })

  it('fetches fresh payload before writing', () => {
    // Must re-fetch the action to get current payload, not use stale action.payload
    expect(code).toContain('freshAction')
    expect(code).toContain('freshPayload')
  })

  it('does NOT have multiple sequential payload writes for is_online and location', () => {
    // The old bug: separate updateAction calls each using action.payload (stale).
    // There should be no pattern of: updateAction({payload: {...currentPayload, is_online}})
    // followed by a separate updateAction({payload: {...currentPayload, editedTo}})
    const matches = code.match(/currentPayload.*is_online/g)
    expect(matches).toBeNull()
  })
})
