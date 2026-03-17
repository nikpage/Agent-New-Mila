import { describe, it, expect, vi, afterEach } from 'vitest'
import { selectOfferMultiplier, computeDaysIgnored } from './scoring'

describe('selectOfferMultiplier', () => {
  it('returns seller multiplier when role is seller', () => {
    expect(selectOfferMultiplier('seller', 1.5, 1.0)).toBe(1.5)
  })

  it('returns buyer multiplier when role is buyer', () => {
    expect(selectOfferMultiplier('buyer', 1.5, 1.0)).toBe(1.0)
  })

  it('returns buyer multiplier when role is null (unknown CP)', () => {
    expect(selectOfferMultiplier(null, 1.5, 1.0)).toBe(1.0)
  })

  it('returns buyer multiplier for any non-seller role', () => {
    expect(selectOfferMultiplier('landlord', 1.5, 1.0)).toBe(1.0)
    expect(selectOfferMultiplier('agent', 1.5, 1.0)).toBe(1.0)
    expect(selectOfferMultiplier('tenant', 1.5, 1.0)).toBe(1.0)
  })
})

describe('computeDaysIgnored', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 0 when last contact is today', () => {
    expect(computeDaysIgnored(new Date().toISOString(), null)).toBe(0)
  })

  it('returns correct days for a past timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-17T12:00:00Z'))
    expect(computeDaysIgnored('2026-03-14T12:00:00Z', null)).toBe(3)
    expect(computeDaysIgnored('2026-03-10T12:00:00Z', null)).toBe(7)
  })

  it('falls back to conversationCreatedAt when no inbound timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-17T12:00:00Z'))
    expect(computeDaysIgnored(null, '2026-03-12T12:00:00Z')).toBe(5)
    expect(computeDaysIgnored(undefined, '2026-03-12T12:00:00Z')).toBe(5)
  })

  it('falls back to now (0 days) when both are null', () => {
    expect(computeDaysIgnored(null, null)).toBe(0)
    expect(computeDaysIgnored(undefined, undefined)).toBe(0)
  })

  it('never returns negative', () => {
    // Future timestamp should clamp to 0
    const tomorrow = new Date(Date.now() + 86400000).toISOString()
    expect(computeDaysIgnored(tomorrow, null)).toBe(0)
  })

  it('accepts Date objects as well as strings', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-17T12:00:00Z'))
    expect(computeDaysIgnored(new Date('2026-03-15T12:00:00Z'), null)).toBe(2)
  })
})
