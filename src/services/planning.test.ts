import { describe, it, expect } from 'vitest'
import { validateDealType, selectOfferMultiplier } from './planning'
import { VALID_DEAL_TYPES, VALID_CP_ROLES } from '@/lib/supabase/types'
import { calculatePriorityScore } from '@/lib/db/actions'

describe('validateDealType', () => {
  it('accepts all valid deal types', () => {
    for (const dt of VALID_DEAL_TYPES) {
      expect(validateDealType(dt)).toBe(dt)
    }
  })

  it('returns null for invalid string (AI hallucination)', () => {
    expect(validateDealType('rent')).toBeNull()
    expect(validateDealType('buying')).toBeNull()
    expect(validateDealType('SALE')).toBeNull() // case-sensitive
    expect(validateDealType('')).toBeNull()
  })

  it('returns null for non-string values', () => {
    expect(validateDealType(null)).toBeNull()
    expect(validateDealType(undefined)).toBeNull()
    expect(validateDealType(42)).toBeNull()
    expect(validateDealType(true)).toBeNull()
  })

  it('valid deal types are exactly: sale, purchase, rental, lease, consultation, other', () => {
    expect([...VALID_DEAL_TYPES]).toEqual([
      'sale', 'purchase', 'rental', 'lease', 'consultation', 'other',
    ])
  })
})

describe('VALID_CP_ROLES', () => {
  it('contains exactly: seller, buyer, landlord, tenant, agent, developer, other', () => {
    expect([...VALID_CP_ROLES]).toEqual([
      'seller', 'buyer', 'landlord', 'tenant', 'agent', 'developer', 'other',
    ])
  })
})

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

describe('offer multiplier affects priority scoring', () => {
  const baseParams = {
    dollarValue: 5_000_000, // 5M CZK typical deal
    urgency: 5,
    painFactor: 3,
    daysIgnored: 2,
  }

  it('seller deal scores higher than buyer deal (same dollar value)', () => {
    const sellerScore = calculatePriorityScore({
      ...baseParams,
      offerMultiplier: selectOfferMultiplier('seller', 1.5, 1.0),
    })
    const buyerScore = calculatePriorityScore({
      ...baseParams,
      offerMultiplier: selectOfferMultiplier('buyer', 1.5, 1.0),
    })
    expect(sellerScore).toBeGreaterThan(buyerScore)
    // With log-scale: seller's offerMultiplier (1.5) is applied BEFORE log,
    // so 5M×1.5=7.5M effective vs 5M×1.0=5M effective.
    // Both compress to similar range (~13 vs ~15) but seller still wins.
    // The difference is modest (not millions) — that's the whole point of log normalization.
    expect(sellerScore - buyerScore).toBeGreaterThan(0)
    expect(sellerScore - buyerScore).toBeLessThan(100) // log-compressed, not millions apart
  })

  it('unknown CP role defaults to buyer multiplier', () => {
    const unknownScore = calculatePriorityScore({
      ...baseParams,
      offerMultiplier: selectOfferMultiplier(null, 1.5, 1.0),
    })
    const buyerScore = calculatePriorityScore({
      ...baseParams,
      offerMultiplier: selectOfferMultiplier('buyer', 1.5, 1.0),
    })
    expect(unknownScore).toBe(buyerScore)
  })
})
