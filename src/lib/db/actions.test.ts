import { describe, it, expect } from 'vitest'
import { calculatePriorityScore } from './actions'

describe('calculatePriorityScore', () => {
  it('calculates basic score with all inputs (linear percentage)', () => {
    // dollarValue=1_000_000, kcHighValue=5_000_000 → BaseDealScore = max(1, round(1M/5M*10)) = max(1,2) = 2
    // Score = (2 * 1) + (5 * 2^1.5) + 0 = 2 + 5*2.83 + 0 = 2 + 14.14 = 16
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 5,
      daysIgnored: 2,
    })
    expect(score).toBe(16)
  })

  it('applies sellerMultiplier to BaseDealScore', () => {
    // 3M / 5M * 10 = 6 → BaseDealScore = 6, × 1.5 = 9
    // Score = 9 + (5 * 0^1.5) + 0 = 9 + 0 = 9 → but urgency term = 5*0 = 0, so 9 + 0 + 0 = 9
    // Wait: daysIgnored=0 so urgency*0^1.5 = 0. Score = 9 + 0 + 0 = 9
    const withMultiplier = calculatePriorityScore({
      dollarValue: 3_000_000,
      urgency: 5,
      daysIgnored: 0,
      sellerMultiplier: 1.5,
    })
    expect(withMultiplier).toBe(9)
  })

  it('includes weight in final score', () => {
    // dollarValue=0 → BaseDealScore = max(1,0) = 1, * 1 = 1
    // Score = 1 + (1 * 0^1.5) + 100 = 1 + 0 + 100 = 101
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 1,
      daysIgnored: 0,
      weight: 100,
    })
    expect(score).toBe(101)
  })

  it('replaces zero urgency with 1 to prevent score collapse', () => {
    // dollarValue=1M → BaseDealScore = max(1, round(1M/5M*10)) = 2
    // urgency 0 → 1, daysIgnored=0: Score = (2*1) + (1*0) + 0 = 2
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 0,
      daysIgnored: 0,
    })
    expect(score).toBe(2)
  })

  it('replaces zero sellerMultiplier with 1', () => {
    const withZero = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 2,
      daysIgnored: 0,
      sellerMultiplier: 0,
    })
    const withDefault = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 2,
      daysIgnored: 0,
      sellerMultiplier: 1,
    })
    // Zero → falls back to 1
    expect(withZero).toBe(withDefault)
  })

  it('daysIgnored growth is ^1.5', () => {
    // dollarValue=0 → BaseDealScore=1
    // day 0: (1*1) + (1*0) + 0 = 1
    // day 5: (1*1) + (1*5^1.5) + 0 = 1 + 11.18 = 12
    // day 10: (1*1) + (1*10^1.5) + 0 = 1 + 31.62 = 33
    const score0 = calculatePriorityScore({ dollarValue: 0, urgency: 1, daysIgnored: 0 })
    const score5 = calculatePriorityScore({ dollarValue: 0, urgency: 1, daysIgnored: 5 })
    const score10 = calculatePriorityScore({ dollarValue: 0, urgency: 1, daysIgnored: 10 })

    expect(score0).toBe(1)
    expect(score5).toBe(12)
    expect(score10).toBe(33)
    // ^1.5: growth from 0→5 < growth from 5→10
    expect(score10 - score5).toBeGreaterThan(score5 - score0)
  })

  it('returns a rounded integer', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_500_000,
      urgency: 3,
      daysIgnored: 1,
      sellerMultiplier: 1.5,
    })
    expect(Number.isInteger(score)).toBe(true)
  })

  it('handles all-zero inputs gracefully (no NaN, no crash)', () => {
    // dollarValue=0 → BaseDealScore=1, urgency→1, days=0
    // Score = (1*1) + (1*0) + 0 = 1
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 0,
      daysIgnored: 0,
    })
    expect(score).toBe(1)
    expect(Number.isFinite(score)).toBe(true)
  })

  // ── Linear percentage normalization behavior ────────────────────────────────

  it('BaseDealScore has hard floor of 1', () => {
    // dollarValue=100 → round(100/5M*10) = 0 → max(1,0) = 1
    const score = calculatePriorityScore({
      dollarValue: 100,
      urgency: 1,
      daysIgnored: 0,
    })
    // (1*1) + (1*0) + 0 = 1
    expect(score).toBe(1)
  })

  it('high anchor value maps to BaseDealScore=10', () => {
    // 5M / 5M * 10 = 10 → BaseDealScore = 10
    // Score = (10*1) + (1*0) + 0 = 10
    const score = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 1,
      daysIgnored: 0,
    })
    expect(score).toBe(10)
  })

  it('values above high anchor extend beyond 10 with no cap', () => {
    // 50M / 5M * 10 = 100 → BaseDealScore = 100
    const bigDeal = calculatePriorityScore({
      dollarValue: 50_000_000,
      urgency: 1,
      daysIgnored: 0,
    })
    // (100*1) + (1*0) + 0 = 100
    expect(bigDeal).toBe(100)
    expect(bigDeal).toBeGreaterThan(10)
  })

  it('small deals get floor of 1 (no negative scores)', () => {
    // 10K / 5M * 10 = 0.02 → round = 0 → max(1,0) = 1
    const tinyDeal = calculatePriorityScore({
      dollarValue: 10_000,
      urgency: 1,
      daysIgnored: 0,
    })
    // (1*1) + (1*0) + 0 = 1
    expect(tinyDeal).toBe(1)
    expect(tinyDeal).toBeGreaterThan(0)
  })

  it('dollarValue=0 still produces BaseDealScore=1 (hard floor)', () => {
    // BaseDealScore = max(1,0) = 1
    // Score = (1*1) + (10 * 3^1.5) + 8 = 1 + 10*5.196 + 8 = 1 + 51.96 + 8 = 61
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 10,
      daysIgnored: 3,
      weight: 8,
    })
    expect(score).toBe(61)
  })

  it('custom kcHighValue shifts the normalization', () => {
    // With kcHighValue=1M: 500K/1M*10 = 5 → BaseDealScore=5
    const customAnchor = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 1,
      daysIgnored: 0,
      kcHighValue: 1_000_000,
    })
    // With default kcHighValue=5M: 500K/5M*10 = 1 → BaseDealScore=1
    const defaultAnchor = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 1,
      daysIgnored: 0,
    })
    // With tighter anchor, 500K scores higher
    expect(customAnchor).toBeGreaterThan(defaultAnchor)
  })

  it('kcHighValue=0 falls back to safe default', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 1,
      daysIgnored: 0,
      kcHighValue: 0,
    })
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThan(0)
  })

  // ── Score spread: deal size doesn't dominate ────────────────────────

  it('urgent small deal beats routine big deal', () => {
    const smallUrgent = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 9,
      daysIgnored: 3,
      weight: 8,
    })
    const bigRoutine = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 2,
      daysIgnored: 0,
      weight: 2,
    })
    expect(smallUrgent).toBeGreaterThan(bigRoutine)
  })
})
