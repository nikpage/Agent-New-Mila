import { describe, it, expect } from 'vitest'
import { validateDealType } from '@/shared/deal-types'
import { selectOfferMultiplier } from '@/shared/scoring'
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
  it('contains exactly: buyer, seller, small-landlord, renter, investor, big-landlord, lawyer, notary, photographer, appraiser, inspector, repair-builder, other', () => {
    expect([...VALID_CP_ROLES]).toEqual([
      'buyer', 'seller', 'small-landlord', 'renter', 'investor', 'big-landlord', 'lawyer', 'notary', 'photographer', 'appraiser', 'inspector', 'repair-builder', 'other',
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
    expect(selectOfferMultiplier('small-landlord', 1.5, 1.0)).toBe(1.0)
    expect(selectOfferMultiplier('agent', 1.5, 1.0)).toBe(1.0)
    expect(selectOfferMultiplier('renter', 1.5, 1.0)).toBe(1.0)
  })
})

describe('offer multiplier affects priority scoring', () => {
  const baseParams = {
    dollarValue: 5_000_000, // 5M CZK typical deal
    urgency: 5,
    daysIgnored: 2,
  }

  it('seller deal scores higher than buyer deal (same dollar value)', () => {
    const sellerScore = calculatePriorityScore({
      ...baseParams,
      sellerMultiplier: selectOfferMultiplier('seller', 1.5, 1.0),
    })
    const buyerScore = calculatePriorityScore({
      ...baseParams,
      sellerMultiplier: selectOfferMultiplier('buyer', 1.5, 1.0),
    })
    expect(sellerScore).toBeGreaterThan(buyerScore)
    // sellerMultiplier (1.5) is applied AFTER log, so normVal = 13 * 1.5 = 19.5 vs 13 * 1.0 = 13
    // Difference = 6.5, which is a real boost (not compressed by log)
    expect(sellerScore - buyerScore).toBeGreaterThan(0)
    expect(sellerScore - buyerScore).toBeLessThan(100)
  })

  it('unknown CP role defaults to buyer multiplier', () => {
    const unknownScore = calculatePriorityScore({
      ...baseParams,
      sellerMultiplier: selectOfferMultiplier(null, 1.5, 1.0),
    })
    const buyerScore = calculatePriorityScore({
      ...baseParams,
      sellerMultiplier: selectOfferMultiplier('buyer', 1.5, 1.0),
    })
    expect(unknownScore).toBe(buyerScore)
  })
})
